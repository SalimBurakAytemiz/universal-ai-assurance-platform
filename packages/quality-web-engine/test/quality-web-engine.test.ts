import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CancellationToken, driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
import { QualityWebEngine, type WebEngineInput } from "@uaap/quality-web-engine";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "fixtures", "web-flows.json"), "utf8")) as WebEngineInput;

let t = 0;
function ctx(input: unknown): EngineContext {
  return { runId: "RUN-WEB", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
}
const drive = (input: unknown) => driveEngine(new QualityWebEngine(), ctx(input));
const kinds = (fs: readonly { kind: string }[]) => new Set(fs.map((f) => f.kind));
const forFlow = (r: { findings: readonly { locator?: string; kind: string }[] }, id: string) => r.findings.filter((f) => (f.locator ?? "").startsWith(`flow ${id}`)).map((f) => f.kind);

describe("QualityWebEngine — recorded web-flow audit against the local fixture", () => {
  it("drives to DONE and flags every planted functional-web issue on login-checkout", async () => {
    const r = await drive(fixture);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = new Set(forFlow(r, "login-checkout"));
    for (const expected of [
      "step-failed",
      "navigation-mismatch",
      "navigation-error-status",
      "navigation-unverifiable",
      "required-element-missing",
      "required-element-not-visible",
      "requirement-unverifiable",
      "forbidden-element-present",
      "console-error",
      "unknown-console-level",
      "network-request-failed",
      "network-request-client-error",
      "network-request-not-ok",
    ]) {
      expect(k, expected).toContain(expected);
    }
  });

  it("does NOT flag the clean flow (no false positives)", async () => {
    const r = await drive(fixture);
    expect(forFlow(r, "clean-browse")).toHaveLength(0);
  });

  it("SECRET-SAFE: never echoes a URL query string (token/PII) or a console message body", async () => {
    const r = await drive(fixture);
    const blob = JSON.stringify(r.findings);
    expect(blob).not.toContain("SECRET123");
    expect(blob).not.toContain("alice@example.test");
    expect(blob).not.toContain("token=");
    expect(blob).not.toContain("irrelevant-should-never-be-echoed");
  });

  it("NO FAKE GREEN: a required element with no recorded presence is UNVERIFIABLE, not a pass", async () => {
    const input: WebEngineInput = { flows: [{ id: "f", steps: [{ action: "assert", requires: [{ selector: "#x" }] }] }] };
    const r = await drive(input);
    expect(kinds(r.findings)).toContain("requirement-unverifiable");
    // and an expected URL with no recorded actual URL is unverifiable, not a silent pass
    const r2 = await drive({ flows: [{ id: "g", steps: [{ action: "navigate", expectedUrl: "/home" }] }] });
    expect(kinds(r2.findings)).toContain("navigation-unverifiable");
  });

  it("passes a fully-recorded, correct step with zero findings", async () => {
    const input: WebEngineInput = { flows: [{ id: "ok", steps: [{ action: "navigate", url: "/a", expectedUrl: "/a", status: 200, requires: [{ selector: "#q", present: true, visible: true }], forbids: [{ selector: ".err", present: false }], console: [{ level: "log" }], network: [{ url: "/api?x=1", status: 200, ok: true }] }] }] };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0);
  });

  it("matches an expected-URL prefix glob and ignores the query string", async () => {
    const ok = await drive({ flows: [{ id: "p", steps: [{ expectedUrl: "/products*", url: "/products/42?ref=abc" }] }] });
    expect(forFlow(ok, "p")).toHaveLength(0);
    const bad = await drive({ flows: [{ id: "p", steps: [{ expectedUrl: "/products*", url: "/account" }] }] });
    expect(kinds(bad.findings)).toContain("navigation-mismatch");
  });

  it("fail-closed on malformed input: PREREQ_FAILED on empty/absent flows, isolates a bad flow/step", async () => {
    expect((await drive({ flows: [] })).status).toBe(EngineStatus.PREREQ_FAILED);
    expect((await drive({})).status).toBe(EngineStatus.PREREQ_FAILED);
    // a null flow is surfaced but does not abort the run; the good flow still audits
    const r = await drive({ flows: [null, { id: "good", steps: [{ ok: false }] }] });
    expect(r.status).toBe(EngineStatus.DONE);
    expect(kinds(r.findings)).toContain("malformed-flow");
    expect(forFlow(r, "good")).toContain("step-failed");
  });

  it("flags a duplicate flow id and keeps the first (fail-closed)", async () => {
    const r = await drive({ flows: [{ id: "dup", steps: [] }, { id: "dup", steps: [{ ok: false }] }] });
    expect(kinds(r.findings)).toContain("duplicate-flow");
    expect(kinds(r.findings)).toContain("empty-flow"); // the first (empty) one was audited
  });

  it("reports offline-only capabilities (no Agent -> Target)", () => {
    const caps = new QualityWebEngine().capabilities();
    expect(caps.offlineOnly).toBe(true);
    expect(caps.domain).toBe("QUALITY");
    expect(caps.capabilities).toContain("web.navigation-correctness");
  });

  // ---- Review round-1 regressions (adversarial findings, all fixed with a test) ----

  it("REGRESSION: a network request recorded ok:false is flagged even with a success/redirect status", async () => {
    for (const status of [200, 204, 302, 0]) {
      const r = await drive({ flows: [{ id: "n", steps: [{ network: [{ url: "/api/x", method: "POST", status, ok: false }] }] }] });
      expect(kinds(r.findings), `status ${status}`).toContain("network-request-not-ok");
    }
    // a 5xx ok:false is the harder P1 failure
    const r5 = await drive({ flows: [{ id: "n", steps: [{ network: [{ url: "/api/x", status: 503, ok: false }] }] }] });
    expect(kinds(r5.findings)).toContain("network-request-failed");
  });

  it("REGRESSION: a required/forbidden element with null or non-boolean `present` is surfaced, never a silent pass", async () => {
    const reqNull = await drive({ flows: [{ id: "f", steps: [{ requires: [{ selector: "#x", present: null as unknown as boolean }] }] }] });
    expect(kinds(reqNull.findings)).toContain("requirement-unverifiable");
    const reqBad = await drive({ flows: [{ id: "f", steps: [{ requires: [{ selector: "#x", present: 0 as unknown as boolean }] }] }] });
    expect(kinds(reqBad.findings)).toContain("malformed-requirement");
    const forbidUnrecorded = await drive({ flows: [{ id: "f", steps: [{ forbids: [{ selector: ".error-banner" }] }] }] });
    expect(kinds(forbidUnrecorded.findings)).toContain("forbidden-unverifiable");
    // an explicitly-absent forbidden element (present:false) is the desired state — no finding
    const forbidAbsent = await drive({ flows: [{ id: "f", steps: [{ forbids: [{ selector: ".error-banner", present: false }] }] }] });
    expect(forFlow(forbidAbsent, "f")).toHaveLength(0);
  });

  it("REGRESSION: SECRET-SAFE — strips URL userinfo (basic-auth) credentials from echoed URLs", async () => {
    const r = await drive({ flows: [{ id: "f", steps: [{ network: [{ url: "https://alice:SUPERSECRET@api.host/login", method: "POST", status: 500 }] }] }] });
    const blob = JSON.stringify(r.findings);
    expect(kinds(r.findings)).toContain("network-request-failed");
    expect(blob).not.toContain("SUPERSECRET");
    expect(blob).not.toContain("alice:");
    expect(blob).toContain("https://api.host/login");
  });

  it("REGRESSION: isolates a throwing flow-identity getter and still audits the following good flow", async () => {
    const hostile: unknown = { get id() { throw new Error("boom"); }, steps: [] };
    const r = await drive({ flows: [hostile, { id: "good", steps: [{ ok: false }] }] });
    expect(r.status).toBe(EngineStatus.DONE); // the run did not crash
    expect(forFlow(r, "good")).toContain("step-failed"); // the good flow was still audited
  });

  it("REGRESSION: standard console types are benign; only a truly-unknown level is surfaced", async () => {
    for (const level of ["table", "dir", "group", "groupEnd", "count", "timeEnd", "debug"]) {
      const r = await drive({ flows: [{ id: "f", steps: [{ console: [{ level }] }] }] });
      expect(forFlow(r, "f"), level).toHaveLength(0);
    }
    const weird = await drive({ flows: [{ id: "f", steps: [{ console: [{ level: "bananas" }] }] }] });
    expect(kinds(weird.findings)).toContain("unknown-console-level");
    const errs = await drive({ flows: [{ id: "f", steps: [{ console: [{ level: "error" }] }] }] });
    expect(kinds(errs.findings)).toContain("console-error");
  });

  it("REGRESSION (round 2): a recorded console.assert is a FAILED assertion => console-error, never benign", async () => {
    const r = await drive({ flows: [{ id: "f", steps: [{ console: [{ level: "assert" }] }] }] });
    expect(kinds(r.findings)).toContain("console-error");
  });

  it("REGRESSION (round 2): safeUrl strips userinfo even when the credential contains '@', '?' or '#'", async () => {
    for (const url of [
      "https://alice:p@ss@api.host/login", // '@' in password -> must strip to the LAST '@'
      "https://user:pa?ss@host/login", // '?' in credential, stripped before query-split
      "https://user:pw#x@host/login", // '#' in credential
      "https://u:SUPERSECRET@host/a", // plain
    ]) {
      const r = await drive({ flows: [{ id: "f", steps: [{ network: [{ url, status: 500 }] }] }] });
      const blob = JSON.stringify(r.findings);
      expect(kinds(r.findings), url).toContain("network-request-failed");
      expect(blob, url).not.toContain("SECRET");
      expect(blob, url).not.toContain("SUPERSECRET");
      expect(blob, url).not.toContain("ss@");
      expect(blob, url).not.toContain("pa?ss");
      expect(blob, url).not.toContain("pw#x");
    }
    // a path that merely contains '@' (after the authority) is NOT stripped
    const keep = await drive({ flows: [{ id: "f", steps: [{ network: [{ url: "https://api.host/users/@handle", status: 500 }] }] }] });
    expect(JSON.stringify(keep.findings)).toContain("/users/@handle");
  });

  it("REGRESSION (round 3): safeUrl is leak-proof on no-path @-in-query, leading whitespace, and /-in-userinfo", async () => {
    // (1) '@' in a QUERY param with NO path: must keep the real host, not over-strip to the mail host,
    // and must not mask a navigation mismatch.
    const q = await drive({ flows: [{ id: "f", steps: [{ network: [{ url: "https://shop.example.com?contact=bob@mail.net", status: 500 }] }] }] });
    const qblob = JSON.stringify(q.findings);
    expect(qblob).toContain("shop.example.com");
    expect(qblob).not.toContain("mail.net");
    // (2) leading whitespace before the scheme must NOT bypass userinfo stripping
    const w = await drive({ flows: [{ id: "f", steps: [{ network: [{ url: " https://alice:LEAKY@api.host/login", status: 500 }] }] }] });
    expect(JSON.stringify(w.findings)).not.toContain("LEAKY");
    // (3) a '/' inside the userinfo must not leave the credential unstripped (redacted when malformed)
    const sl = await drive({ flows: [{ id: "f", steps: [{ network: [{ url: "https://user:pa/SS@host/x", status: 500 }] }] }] });
    expect(JSON.stringify(sl.findings)).not.toContain("SS@");
    // navigation must not falsely MATCH two different hosts that only share a post-@ query tail
    const nav = await drive({ flows: [{ id: "f", steps: [{ expectedUrl: "https://good.example.com", url: "https://evil.example.com?x=a@good.example.com" }] }] });
    expect(kinds(nav.findings)).toContain("navigation-mismatch");
  });

  it("REGRESSION (round 4): opaque-path / non-authority schemes never leak userinfo (redacted, not re-emitted)", async () => {
    for (const url of [
      "foo:user:pass@host/path", // opaque-path scheme: WHATWG keeps 'user:pass@' inside pathname
      "custom:alice:SECRET@host", // same class
      "blob:https://user:pass@example.com:8443/uuid?token=SECRET", // blob inner URL carries userinfo in pathname
    ]) {
      const r = await drive({ flows: [{ id: "f", steps: [{ network: [{ url, failed: true }] }] }] });
      const blob = JSON.stringify(r.findings);
      expect(blob, url).not.toContain("user:pass");
      expect(blob, url).not.toContain("SECRET");
      expect(blob, url).not.toContain("alice:SECRET");
    }
  });

  it("REGRESSION: a cancellation yields CANCELLED, never a swallowed engine-error finding", async () => {
    const tok = new CancellationToken();
    tok.cancel("test-cancel");
    const r = await driveEngine(new QualityWebEngine(), ctx({ flows: [{ id: "f", steps: [{ ok: false }, { ok: false }] }] }), { token: tok });
    expect(r.status).toBe(EngineStatus.CANCELLED);
    expect(kinds(r.findings)).not.toContain("engine-error");
  });
});
