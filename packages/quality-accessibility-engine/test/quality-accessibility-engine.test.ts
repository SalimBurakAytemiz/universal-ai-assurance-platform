import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { driveEngine, EngineStatus, type EngineContext } from "@uaap/engine-core";
import { QualityAccessibilityEngine, type A11yEngineInput } from "@uaap/quality-accessibility-engine";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "..", "fixtures", "checkout-page.json"), "utf8")) as A11yEngineInput;

let t = 0;
function ctx(input: unknown): EngineContext {
  return { runId: "RUN-A11Y", input, now: () => new Date(Date.UTC(2026, 9, 6, 0, 0, t++)).toISOString() };
}
const drive = (input: unknown) => driveEngine(new QualityAccessibilityEngine(), ctx(input));
const kinds = (fs: readonly { kind: string }[]) => new Set(fs.map((f) => f.kind));
const forPage = (r: { findings: readonly { locator?: string; kind: string }[] }, id: string) => r.findings.filter((f) => (f.locator ?? "").startsWith(`page ${id}`)).map((f) => f.kind);

describe("QualityAccessibilityEngine — snapshot audit against the local fixture", () => {
  it("drives to DONE and flags every planted a11y/visual issue on /checkout", async () => {
    const r = await drive(fixture);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = new Set(forPage(r, "/checkout"));
    for (const expected of ["image-missing-alt", "control-missing-label", "missing-accessible-name", "heading-skip", "duplicate-id", "contrast-insufficient", "visual-regression"]) {
      expect(k, expected).toContain(expected);
    }
  });

  it("does NOT flag the clean page (no false positives)", async () => {
    const r = await drive(fixture);
    expect(forPage(r, "/clean")).toHaveLength(0);
  });

  it("treats alt=\"\" as a valid decorative image (not missing alt)", async () => {
    const input: A11yEngineInput = { pages: [{ id: "p", lang: "en", elements: [{ tag: "img", alt: "" }, { tag: "img", presentation: true }] }] };
    const r = await drive(input);
    expect(kinds(r.findings)).not.toContain("image-missing-alt");
  });

  it("flags a missing document language", async () => {
    const input: A11yEngineInput = { pages: [{ id: "p", elements: [{ tag: "h1", text: "x" }] }] };
    expect(kinds((await drive(input)).findings)).toContain("missing-lang");
  });

  it("computes contrast from colors: fails below AA, passes above, relaxes for large text", async () => {
    const low = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "span", text: "x", fg: "#999999", bg: "#ffffff" }] }] });
    expect(kinds(low.findings)).toContain("contrast-insufficient");
    const ok = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "span", text: "x", fg: "#595959", bg: "#ffffff" }] }] });
    expect(kinds(ok.findings)).not.toContain("contrast-insufficient"); // ~7:1
    // #949494 on white is ~3.1:1 — fails normal (4.5) but passes large-text (3)
    const large = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "span", text: "x", fg: "#949494", bg: "#ffffff", largeText: true }] }] });
    expect(kinds(large.findings)).not.toContain("contrast-insufficient");
  });

  it("isolates a malformed element/page and still audits the rest", async () => {
    const input = { pages: [null, { id: "p", lang: "en", elements: [null, { tag: "img" }] }] };
    const r = await drive(input);
    expect(r.status).toBe(EngineStatus.DONE);
    const k = kinds(r.findings);
    expect(k).toContain("malformed-page");
    expect(k).toContain("malformed-element");
    expect(k).toContain("image-missing-alt"); // the valid element was still audited
    expect(k).not.toContain("engine-error");
  });

  it("fails closed on a duplicate page id (keeps first)", async () => {
    const input = { pages: [{ id: "p", lang: "en", elements: [] }, { id: "p", lang: "en", elements: [] }] };
    expect(kinds((await drive(input)).findings)).toContain("duplicate-page");
  });

  it("PREREQ_FAILED when there are no pages; non-array inputs never crash", async () => {
    expect((await drive({ pages: [] })).status).toBe(EngineStatus.PREREQ_FAILED);
    const r2 = await drive({ pages: "nope" });
    expect([EngineStatus.PREREQ_FAILED, EngineStatus.DONE]).toContain(r2.status);
  });

  it("reports offline-only accessibility + visual capabilities", () => {
    const caps = new QualityAccessibilityEngine().capabilities();
    expect(caps.engineId).toBe("qa.accessibility-engine");
    expect(caps.domain).toBe("ACCESSIBILITY");
    expect(caps.offlineOnly).toBe(true);
    expect(caps.capabilities).toContain("visual.regression");
  });
});

describe("QualityAccessibilityEngine — review-fix regressions (name sources, roles, whitespace)", () => {
  it("an image named only via title is NOT flagged (title is a valid accessible name)", async () => {
    const r = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "img", title: "Company logo" }] }] });
    expect(kinds(r.findings)).not.toContain("image-missing-alt");
  });

  it("name-requiring ARIA roles (searchbox / menuitemcheckbox / menuitemradio) without a name are flagged", async () => {
    const r = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "div", role: "searchbox" }, { tag: "div", role: "menuitemcheckbox" }, { tag: "div", role: "menuitemradio" }] }] });
    const k = kinds(r.findings);
    expect(k).toContain("control-missing-label"); // searchbox
    expect(k).toContain("missing-accessible-name"); // menuitemcheckbox/radio
  });

  it("a whitespace-only name is not a real name (flagged as unnamed)", async () => {
    const button = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "button", ariaLabel: " " }] }] });
    expect(kinds(button.findings)).toContain("missing-accessible-name");
    const input = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "input", ariaLabel: "  " }] }] });
    expect(kinds(input.findings)).toContain("control-missing-label");
    const img = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "img", ariaLabel: " " }] }] });
    expect(kinds(img.findings)).toContain("image-missing-alt");
  });

  it("a properly title-labelled control is still accepted (no false positive from the trim change)", async () => {
    const r = await drive({ pages: [{ id: "p", lang: "en", elements: [{ tag: "input", title: "Email" }, { tag: "button", ariaLabel: "Submit" }] }] });
    const k = kinds(r.findings);
    expect(k).not.toContain("control-missing-label");
    expect(k).not.toContain("missing-accessible-name");
  });
});
