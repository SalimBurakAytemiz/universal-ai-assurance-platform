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
