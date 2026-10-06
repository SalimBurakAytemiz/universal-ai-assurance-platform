import { describe, it, expect } from "vitest";
import { EngineStatus } from "@uaap/engine-core";
import { isLocalTarget, toLocalUrl, validateCapturedFlow } from "@uaap/quality-web-live-adapter";

// These tests exercise the PURE adapter surface (local-target allow-list + capture->engine routing)
// with NO browser — so they run in CI. The real browser drive is validated by smoke/live-capture.mjs.

describe("@uaap/quality-web-live-adapter — local-target allow-list (fail-closed)", () => {
  it("allows only genuinely local targets", () => {
    for (const ok of [
      "data:text/html,<h1>x</h1>",
      "file:///C:/tmp/a.html",
      "http://localhost:3000/x",
      "http://127.0.0.1/x",
      "https://app.localhost/x",
      "http://svc.test/x",
      "fixtures/clean.html", // bare relative path -> local file
    ]) {
      expect(isLocalTarget(ok), ok).toBe(true);
    }
  });

  it("REFUSES any non-local / external target", () => {
    for (const bad of [
      "https://example.com/x",
      "http://evil.org",
      "https://169.254.169.254/latest", // cloud metadata — must be refused
      "http://10.0.0.5/x",
      "ftp://host/x",
      "",
    ]) {
      expect(isLocalTarget(bad), bad).toBe(false);
    }
  });

  it("REGRESSION (SSRF): refuses remote-authority forms that masquerade as local", () => {
    for (const bad of [
      "file://evil.com/share/x", // file: with a REMOTE host -> Windows UNC/SMB (NTLM leak)
      "file://169.254.169.254/x",
      "//evil.com/x", // protocol-relative authority
      "\\\\evil.com\\x", // UNC path
      "http://localhost@evil.com/x", // userinfo trick -> host is evil.com
      "http://localhost.evil.com/x", // suffix trick
      "http://127.0.0.1.evil.com/x",
      "file:////host/share", // UNC-in-path: empty host but //host path -> Chrome loads \\host\share
      "file://///host/share",
    ]) {
      expect(isLocalTarget(bad), bad).toBe(false);
    }
    // ...while genuinely-local file forms remain allowed:
    for (const ok of ["file:///C:/tmp/a.html", "file://localhost/C:/tmp/a.html", "/abs/path.html"]) {
      expect(isLocalTarget(ok), ok).toBe(true);
    }
    expect(() => toLocalUrl("//evil.com/x")).toThrow(/non-local/);
  });

  it("toLocalUrl converts a bare path to file:// and throws on a non-local target", () => {
    expect(toLocalUrl("data:text/html,x")).toBe("data:text/html,x");
    expect(toLocalUrl("a/b.html")).toMatch(/^file:\/\/\/.*a\/b\.html$/);
    expect(() => toLocalUrl("https://example.com")).toThrow(/non-local/);
  });
});

describe("@uaap/quality-web-live-adapter — captured flow routes through the fail-closed engine", () => {
  it("surfaces planted functional issues from a BROKEN capture", async () => {
    // A WebFlow exactly as driveAndCaptureFlow would produce from a broken page.
    const flow = {
      id: "login",
      steps: [
        {
          action: "navigate",
          url: "/login",
          expectedUrl: "/login",
          status: 200,
          requires: [{ selector: "#submit", present: false }],
          forbids: [{ selector: ".error-banner", present: true }],
          console: [{ level: "error" }],
          network: [{ url: "/api/x", method: "GET", status: 404 }],
          ok: true,
        },
      ],
    };
    const r = await validateCapturedFlow(flow);
    expect(r.status).toBe(EngineStatus.DONE);
    const kinds = new Set(r.findings.map((f) => f.kind));
    expect(kinds).toContain("required-element-missing");
    expect(kinds).toContain("forbidden-element-present");
    expect(kinds).toContain("console-error");
    expect(kinds).toContain("network-request-client-error");
  });

  it("passes a CLEAN capture with zero findings", async () => {
    const flow = {
      id: "clean",
      steps: [
        {
          action: "navigate",
          url: "/",
          expectedUrl: "/",
          status: 200,
          requires: [{ selector: "#hero", present: true, visible: true }, { selector: "#submit", present: true, visible: true }],
          forbids: [{ selector: ".error-banner", present: false }],
          console: [{ level: "info" }],
          network: [{ url: "/api/data", method: "GET", status: 200, ok: true }],
          ok: true,
        },
      ],
    };
    const r = await validateCapturedFlow(flow);
    expect(r.status).toBe(EngineStatus.DONE);
    expect(r.findings).toHaveLength(0);
  });
});
