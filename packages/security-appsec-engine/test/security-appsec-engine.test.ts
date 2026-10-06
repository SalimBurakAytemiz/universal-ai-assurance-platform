import { describe, it, expect } from "vitest";
import { driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
import { SecurityAppsecEngine, type AppsecEngineInput } from "@uaap/security-appsec-engine";

let t = 0;
function ctx(input: unknown): EngineContext {
  return { runId: "RUN-SEC", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
}
const drive = (input: unknown) => driveEngine(new SecurityAppsecEngine(), ctx(input));
const kinds = (fs: readonly { kind: string }[]) => new Set(fs.map((f) => f.kind));

// Secret-LIKE strings assembled from fragments so no verbatim secret is committed (keeps the repo's
// own "no committed secrets" scanner green while the engine still sees full patterns at runtime).
const AWS_KEY = "AKIA" + "QRSTUVWX0123ABCD";
const PRIVATE_KEY_HEADER = "-----BEGIN " + "RSA PRIVATE KEY-----";
const SLACK = "xoxb-" + "2222222222-abcdefghijentry";

const vulnerable: AppsecEngineInput = {
  sources: [
    {
      path: "src/db.ts",
      content: [
        `const q = \`SELECT * FROM users WHERE id = \${userId}\`;`,
        `const key = "${AWS_KEY}";`,
        `const token = "${SLACK}";`,
        `el.innerHTML = userInput;`,
      ].join("\n"),
    },
    { path: "keys/id_rsa", content: `${PRIVATE_KEY_HEADER}\nMIIabc...\n-----END RSA PRIVATE KEY-----` },
  ],
  config: [{ path: "config/prod.json", content: `{ "rejectUnauthorized": false, "debug": true }` }],
  headers: [{ id: "GET /", headers: { "content-type": "text/html", "access-control-allow-origin": "*", "access-control-allow-credentials": "true" } }],
  dependencies: [{ name: "lodash", version: "4.17.11", advisories: [{ id: "CVE-2019-10744", severity: "P1", affected: ["4.17.11"] }] }],
  tls: [{ host: "legacy.example", protocol: "TLSv1.0", cipher: "ECDHE-RSA-RC4-SHA" }],
};

describe("SecurityAppsecEngine — detection-only static scan", () => {
  it("drives to DONE and detects every planted weakness class", async () => {
    const r = await drive(vulnerable);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    for (const expected of ["hardcoded-secret", "sql-injection-pattern", "xss-sink", "missing-security-header", "permissive-cors", "vulnerable-dependency", "weak-tls-protocol", "weak-tls-cipher"]) {
      expect(k, expected).toContain(expected);
    }
  });

  it("REDACTS secret values — the finding never echoes the secret", async () => {
    const r = await drive(vulnerable);
    const secretFindings = r.findings.filter((f) => f.kind === "hardcoded-secret");
    expect(secretFindings.length).toBeGreaterThan(0);
    const all = JSON.stringify(r);
    expect(all).not.toContain(AWS_KEY); // the actual key is never present in any finding/evidence
    expect(all).not.toContain(SLACK);
    for (const f of secretFindings) expect(f.detail).toMatch(/REDACTED/);
  });

  it("every finding is a detection SIGNAL requiring verification (detector is not a closure authority)", async () => {
    const r = await drive(vulnerable);
    const nonMalformed = r.findings.filter((f) => f.kind !== "malformed-artifact");
    for (const f of nonMalformed) expect(f.detail.toLowerCase()).toMatch(/signal|requires.*verification/);
    const ev = r.evidence[0];
    expect((ev?.data as { mode?: string })?.mode).toBe("DETECTION_ONLY");
    expect((ev?.data as { activeValidation?: string })?.activeValidation).toBe("LOCKED_BY_DESIGN");
  });

  it("a clean set of artifacts yields DONE with zero signals — a REAL pass", async () => {
    const clean: AppsecEngineInput = {
      sources: [{ path: "src/ok.ts", content: `const key = process.env.API_KEY;\nconst q = db.query("SELECT 1");` }],
      config: [{ path: "config/prod.json", content: `{ "rejectUnauthorized": true }` }],
      headers: [{ id: "GET /", headers: { "content-security-policy": "default-src 'self'", "x-content-type-options": "nosniff", "strict-transport-security": "max-age=63072000", "x-frame-options": "DENY" } }],
      dependencies: [{ name: "lodash", version: "4.17.21", advisories: [{ id: "CVE-2019-10744", affected: ["4.17.11"] }] }],
      tls: [{ host: "ok.example", protocol: "TLSv1.3", cipher: "TLS_AES_128_GCM_SHA256" }],
    };
    const r = await drive(clean);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0);
  });

  it("a dependency advisory with no affected list is treated as applying (fail-closed)", async () => {
    const r = await drive({ dependencies: [{ name: "x", version: "1.0.0", advisories: [{ id: "ADV-1" }] }] });
    expect(kinds(r.findings)).toContain("vulnerable-dependency");
  });

  it("isolates a malformed artifact and still scans the rest", async () => {
    const r = await drive({ sources: [null, { path: "a.ts", content: "eval(x)" }] });
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    expect(k).toContain("malformed-artifact");
    expect(k).toContain("code-eval");
    expect(k).not.toContain("engine-error");
  });

  it("PREREQ_FAILED when no artifacts are provided; non-object input never crashes", async () => {
    expect((await drive({})).status).toBe(EngineStatus.PREREQ_FAILED);
    expect([EngineStatus.PREREQ_FAILED, EngineStatus.DONE]).toContain((await drive("nope")).status);
  });

  it("reports offline-only, detection-only security capabilities", () => {
    const caps = new SecurityAppsecEngine().capabilities();
    expect(caps.engineId).toBe("sec.appsec-engine");
    expect(caps.domain).toBe("SECURITY");
    expect(caps.offlineOnly).toBe(true);
    expect(caps.capabilities).toContain("sec.secrets");
  });
});

describe("SecurityAppsecEngine — review-fix regressions (no secret leak, JSON keys, rule precision)", () => {
  const LEAK_KEY = "AKIA" + "LEAKTEST9012ABCD";
  it("P0: a secret co-located with a non-redacted rule match NEVER leaks (per-line redaction)", async () => {
    const inputs = [
      { sources: [{ path: "x.ts", content: `el.innerHTML = "${LEAK_KEY}";` }] }, // xss-sink echoes the line
      { sources: [{ path: "y.ts", content: `eval("${LEAK_KEY}")` }] }, // code-eval echoes the line
      { config: [{ path: "c.js", content: `module.exports = { debug: true, password: "${LEAK_KEY}" };` }] }, // debug-enabled echoes the line
    ];
    for (const input of inputs) {
      const r = await drive(input);
      expect(JSON.stringify(r)).not.toContain(LEAK_KEY); // the key is masked everywhere, incl. the echoing sibling rule
      expect(kinds(r.findings)).toContain("hardcoded-secret"); // still detected (redacted)
    }
  });

  it("detects insecure config + credentials in JSON (quoted keys), not just env/JS", async () => {
    const r = await drive({ config: [{ path: "prod.json", content: `{ "rejectUnauthorized": false, "debug": true, "ssl": false, "password": "hunter2longpw" }` }] });
    const k = kinds(r.findings);
    expect(k).toContain("insecure-tls-verification-disabled");
    expect(k).toContain("debug-enabled");
    expect(k).toContain("ssl-disabled");
    expect(k).toContain("hardcoded-secret");
    expect(JSON.stringify(r)).not.toContain("hunter2longpw"); // credential value masked even via debug-enabled echo
  });

  it("SQL-concat rule requires real SQL structure (no cry-wolf on English prose)", async () => {
    const benign = await drive({ sources: [{ path: "a.ts", content: `const msg = "please update the record " + name;` }] });
    expect(kinds(benign.findings)).not.toContain("sql-injection-pattern");
    const real = await drive({ sources: [{ path: "b.ts", content: `const q = "SELECT name FROM users WHERE id=" + id;` }] });
    expect(kinds(real.findings)).toContain("sql-injection-pattern");
  });

  it("XSS sink flags assignment, not comparison", async () => {
    const cmp = await drive({ sources: [{ path: "a.ts", content: `if (node.innerHTML === "") return;` }] });
    expect(kinds(cmp.findings)).not.toContain("xss-sink");
    const asn = await drive({ sources: [{ path: "b.ts", content: `node.innerHTML = userInput;` }] });
    expect(kinds(asn.findings)).toContain("xss-sink");
  });

  it("weak-TLS cipher detection includes 3DES", async () => {
    const r = await drive({ tls: [{ host: "h", protocol: "TLSv1.2", cipher: "ECDHE-RSA-3DES-EDE-CBC-SHA" }] });
    expect(kinds(r.findings)).toContain("weak-tls-cipher");
  });
});

describe("SecurityAppsecEngine — residual-leak closure (no raw line echo, by construction)", () => {
  it("a snake_case credential co-located with a non-secret rule never leaks AND is now detected", async () => {
    const VAL = "Sup3rS3cr3tValue1";
    const r = await drive({ config: [{ path: "prod.json", content: `{ "debug": true, "db_password": "${VAL}" }` }] });
    expect(JSON.stringify(r)).not.toContain(VAL);
    expect(kinds(r.findings)).toContain("hardcoded-secret"); // generic compound-key rule catches db_password
    expect(kinds(r.findings)).toContain("debug-enabled");
  });

  it("an aws_secret_access_key compound key is detected and its value never leaks", async () => {
    const VAL = "wJalr0utnFEMIK7MDENGxyz123fakeSECRET99aa";
    const r = await drive({ config: [{ path: "prod.json", content: `{ "ssl": false, "aws_secret_access_key": "${VAL}" }` }] });
    expect(JSON.stringify(r)).not.toContain(VAL);
    expect(kinds(r.findings)).toContain("hardcoded-secret");
  });

  it("an embedded-quote credential value does not leak its tail", async () => {
    const r = await drive({ config: [{ path: "prod.json", content: `{ "ssl": false, "password": "abc'tail1234plus" }` }] });
    expect(JSON.stringify(r)).not.toContain("tail1234plus");
  });

  it("a secret of an UNRECOGNIZED shape co-located with a non-secret rule still never leaks (no content echo)", async () => {
    const VAL = "gAAAA-unmodeled-high-entropy-9f8e7d6c5b4a3210";
    const r = await drive({ sources: [{ path: "a.ts", content: `eval(userCode); const t = "${VAL}";` }] });
    expect(JSON.stringify(r)).not.toContain(VAL); // code-eval finding no longer echoes the line
    expect(kinds(r.findings)).toContain("code-eval");
  });
});

describe("SecurityAppsecEngine — credential-rule precision (final re-review)", () => {
  it("does NOT flag descriptor keys whose credential word is a prefix/middle (token_type: Bearer etc.)", async () => {
    const r = await drive({
      config: [{ path: "oauth.json", content: `{ "token_type": "Bearer", "tokenEndpoint": "https://idp.example/token", "access_token_url": "https://x/oauth", "secretName": "my-ref" }` }],
    });
    expect(kinds(r.findings)).not.toContain("hardcoded-secret"); // all are descriptor keys / public constants / URLs
  });

  it("STILL flags real trailing-credential keys with concrete values", async () => {
    const r = await drive({ config: [{ path: "a.json", content: `{ "auth_token": "t0ps3cr3tTokenVal" }` }, { path: "b.json", content: `{ "db_password": "P@ssw0rdValue9" }` }] });
    expect(r.findings.filter((f) => f.kind === "hardcoded-secret").length).toBe(2); // both key shapes match
  });
});
