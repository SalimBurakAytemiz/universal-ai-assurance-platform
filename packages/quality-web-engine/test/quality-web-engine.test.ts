import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
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
});
