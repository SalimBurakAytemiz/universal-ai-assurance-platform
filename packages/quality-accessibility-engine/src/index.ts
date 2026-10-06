// @uaap/quality-accessibility-engine — an accessibility + visual assurance engine on the
// @uaap/engine-core lifecycle. It runs deterministic WCAG-style checks over captured page SNAPSHOTS
// (an accessibility-tree-like element list per page): image alt text, form-control labels, accessible
// names for interactive elements, document language, heading-order, duplicate ids, text contrast
// ratio (computed from provided fg/bg colors), and visual-regression (baseline vs current hash).
// OFFLINE-ONLY: it inspects snapshots that were already captured (local fixtures today; a Playwright
// capture transport later) — no browser is driven here, nothing to authorize. Fail-closed: a clean
// snapshot yields zero findings; malformed input is surfaced, never crashes the run.
import type { Severity } from "@uaap/core";
import {
  CancellationToken,
  finding,
  HealthStatus,
  type Discovery,
  type EngineCapabilities,
  type EngineCollector,
  type EngineContext,
  type EngineFinding,
  type EngineHealth,
  type EnginePlan,
  type ExecutionEngine,
  type PrereqResult,
} from "@uaap/engine-core";

export interface A11yElement {
  readonly tag: string;
  readonly role?: string;
  readonly id?: string;
  readonly accessibleName?: string;
  readonly alt?: string;
  readonly ariaLabel?: string;
  readonly ariaHidden?: boolean;
  readonly title?: string;
  /** The capturer resolved an associated <label> (for=/wrapping) for this control. */
  readonly labelled?: boolean;
  readonly href?: string;
  readonly headingLevel?: number;
  readonly text?: string;
  /** Decorative (role=presentation or intentionally hidden) — exempt from name/alt rules. */
  readonly presentation?: boolean;
  /** Foreground / background colors as #rrggbb for contrast; `largeText` relaxes the threshold. */
  readonly fg?: string;
  readonly bg?: string;
  readonly largeText?: boolean;
}
export interface A11yPage {
  readonly id: string;
  readonly lang?: string;
  readonly elements: readonly A11yElement[];
  readonly visual?: { readonly baselineHash?: string; readonly currentHash?: string };
}
export interface A11yEngineInput {
  readonly pages: readonly A11yPage[];
}

const SEV = { P0: "P0", P1: "P1", P2: "P2", P3: "P3" } as const;
const CONTROL_TAGS = new Set(["input", "select", "textarea"]);
const CONTROL_ROLES = new Set(["textbox", "combobox", "listbox", "checkbox", "radio", "switch", "spinbutton", "slider"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "tab"]);
const NON_NAME_INPUT_TYPES = new Set(["hidden"]);

function accName(el: A11yElement): string {
  return (el.accessibleName ?? el.ariaLabel ?? el.title ?? el.text ?? "").trim();
}

/** WCAG relative luminance of an #rrggbb color, or null if the hex is unparseable. */
function luminance(hex: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1]!;
  const ch = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function contrastRatio(fg: string, bg: string): number | null {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  if (l1 === null || l2 === null) return null;
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export class QualityAccessibilityEngine implements ExecutionEngine {
  capabilities(): EngineCapabilities {
    return {
      engineId: "qa.accessibility-engine",
      domain: "ACCESSIBILITY",
      version: "0.1.0",
      capabilities: ["a11y.image-alt", "a11y.control-label", "a11y.accessible-name", "a11y.document-lang", "a11y.heading-order", "a11y.duplicate-id", "a11y.contrast", "visual.regression"],
      offlineOnly: true,
    };
  }
  health(): EngineHealth {
    return { status: HealthStatus.HEALTHY };
  }

  private input(ctx: EngineContext): A11yEngineInput {
    return ctx.input as A11yEngineInput;
  }
  private pagesOf(ctx: EngineContext): readonly A11yPage[] {
    const p = (this.input(ctx) as { pages?: unknown })?.pages;
    return Array.isArray(p) ? (p as A11yPage[]) : [];
  }

  discover(ctx: EngineContext): Discovery {
    const pages = this.pagesOf(ctx);
    return { items: pages.map((p) => p?.id), summary: `${pages.length} page snapshot(s)` };
  }
  plan(ctx: EngineContext, _d: Discovery): EnginePlan {
    const pages = this.pagesOf(ctx);
    return { steps: pages.map((p) => ({ page: p?.id })), summary: `audit ${pages.length} page(s)` };
  }
  validatePrereqs(ctx: EngineContext, _p: EnginePlan): PrereqResult {
    const input = this.input(ctx);
    const missing: string[] = [];
    if (!input || typeof input !== "object") missing.push("input is missing");
    else if (!Array.isArray(input.pages) || input.pages.length === 0) missing.push("pages is empty");
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken, collector: EngineCollector): void {
    let audited = 0;
    const pages = this.pagesOf(ctx);
    const seenPageIds = new Set<string>();
    for (const page of pages) {
      token.throwIfCancelled();
      if (!(page && typeof page === "object" && typeof page.id === "string")) {
        collector.finding(finding({ severity: SEV.P2, kind: "malformed-page", title: "Malformed page snapshot", detail: "A page is null or has no string id; skipped.", locator: "pages" }));
        continue;
      }
      if (seenPageIds.has(page.id)) {
        collector.finding(finding({ severity: SEV.P2, kind: "duplicate-page", title: "Duplicate page id", detail: `Page id "${page.id}" appears more than once; the later snapshot is ignored (first kept).`, locator: `page ${page.id}` }));
        continue;
      }
      seenPageIds.add(page.id);
      const loc = `page ${page.id}`;
      try {
        audited++;
        let violations = 0;
        const add = (f: EngineFinding) => {
          violations++;
          collector.finding(f);
        };
        const elements = Array.isArray(page.elements) ? page.elements : [];
        if (!Array.isArray(page.elements)) add(finding({ severity: SEV.P2, kind: "malformed-page", title: "Page has no elements array", detail: `Page "${page.id}" has no elements array; its element rules could not run.`, locator: loc }));

        // Document language (page-level).
        if (typeof page.lang !== "string" || page.lang.trim() === "") add(finding({ severity: SEV.P2, kind: "missing-lang", title: "Missing document language", detail: `Page "${page.id}" has no lang; assistive tech cannot determine the language.`, locator: loc }));

        const idCounts = new Map<string, number>();
        const headings: { level: number; i: number }[] = [];

        elements.forEach((el, i) => {
          const eloc = `${loc} el[${i}]`;
          if (!el || typeof el !== "object" || typeof el.tag !== "string") {
            add(finding({ severity: SEV.P2, kind: "malformed-element", title: "Malformed element", detail: `Element ${i} is null or has no string tag; skipped.`, locator: eloc }));
            return;
          }
          const tag = el.tag.toLowerCase();
          const role = el.role?.toLowerCase();
          const decorative = el.presentation === true || el.ariaHidden === true || role === "presentation" || role === "none";

          if (typeof el.id === "string" && el.id) idCounts.set(el.id, (idCounts.get(el.id) ?? 0) + 1);

          // Image alt text. An alt ATTRIBUTE that is present — even empty ("") — is valid: alt="" is
          // the correct marker for a decorative image. Only a MISSING alt (with no aria-label /
          // accessible name) is a violation.
          if ((tag === "img" || role === "img") && !decorative) {
            const hasAltAttr = typeof el.alt === "string";
            if (!hasAltAttr && !el.ariaLabel && !el.accessibleName) add(finding({ severity: SEV.P1, kind: "image-missing-alt", title: "Image missing alt attribute", detail: `<${tag}> has no alt attribute, aria-label, or accessible name (use alt="" for a decorative image).`, locator: eloc }));
          }
          // Form-control label.
          const isControl = (CONTROL_TAGS.has(tag) && !NON_NAME_INPUT_TYPES.has(String((el as { type?: string }).type ?? ""))) || (role !== undefined && CONTROL_ROLES.has(role));
          if (isControl && !decorative) {
            if (!el.labelled && !el.ariaLabel && !el.accessibleName && !el.title) add(finding({ severity: SEV.P1, kind: "control-missing-label", title: "Form control missing label", detail: `<${tag}${role ? ` role=${role}` : ""}> has no associated label / aria-label / accessible name.`, locator: eloc }));
          }
          // Interactive accessible name (button / link).
          const isInteractive = tag === "button" || (tag === "a" && typeof el.href === "string" && el.href !== "") || (role !== undefined && INTERACTIVE_ROLES.has(role));
          if (isInteractive && !decorative) {
            if (accName(el) === "" && !el.ariaLabel && !el.accessibleName) add(finding({ severity: SEV.P1, kind: "missing-accessible-name", title: "Interactive element missing accessible name", detail: `<${tag}${role ? ` role=${role}` : ""}> has no text / aria-label / accessible name.`, locator: eloc }));
          }
          // Headings (for order check).
          const hMatch = /^h([1-6])$/.exec(tag);
          const level = el.headingLevel ?? (hMatch ? Number(hMatch[1]) : role === "heading" ? el.headingLevel : undefined);
          if (typeof level === "number" && Number.isInteger(level) && level >= 1 && level <= 6) headings.push({ level, i });

          // Contrast (only when both colors are provided).
          if (typeof el.fg === "string" && typeof el.bg === "string" && !decorative) {
            const ratio = contrastRatio(el.fg, el.bg);
            if (ratio === null) add(finding({ severity: SEV.P3, kind: "malformed-color", title: "Unparseable color", detail: `Element ${i} has an unparseable fg/bg color (${el.fg}/${el.bg}); contrast not checked.`, locator: eloc }));
            else {
              const threshold = el.largeText ? 3 : 4.5;
              if (ratio < threshold) add(finding({ severity: SEV.P2, kind: "contrast-insufficient", title: "Insufficient text contrast", detail: `contrast ratio ${ratio.toFixed(2)}:1 is below the WCAG AA minimum ${threshold}:1 for ${el.largeText ? "large" : "normal"} text.`, locator: eloc }));
            }
          }
        });

        // Heading order: no skipped levels in document order.
        let prevLevel = 0;
        for (const h of headings) {
          if (prevLevel !== 0 && h.level > prevLevel + 1) add(finding({ severity: SEV.P2, kind: "heading-skip", title: "Skipped heading level", detail: `heading level h${h.level} follows h${prevLevel}, skipping a level.`, locator: `${loc} el[${h.i}]` }));
          prevLevel = h.level;
        }

        // Duplicate ids.
        for (const [id, n] of idCounts) {
          if (n > 1) add(finding({ severity: SEV.P3, kind: "duplicate-id", title: "Duplicate element id", detail: `id "${id}" is used ${n} times on page "${page.id}".`, locator: loc }));
        }

        // Visual regression (baseline vs current snapshot hash).
        const v = page.visual;
        if (v && typeof v === "object") {
          if (typeof v.baselineHash === "string" && typeof v.currentHash === "string") {
            if (v.baselineHash !== v.currentHash) add(finding({ severity: SEV.P2, kind: "visual-regression", title: "Visual regression", detail: `current snapshot hash ${v.currentHash.slice(0, 12)} != baseline ${v.baselineHash.slice(0, 12)}.`, locator: loc }));
          } else if (typeof v.baselineHash === "string" || typeof v.currentHash === "string") {
            add(finding({ severity: SEV.P3, kind: "visual-unverifiable", title: "Visual comparison incomplete", detail: `Page "${page.id}" has only one of baseline/current snapshot hash; visual regression not verifiable.`, locator: loc }));
          }
        }

        collector.evidence({
          producedBy: "qa.accessibility-engine",
          action: "a11y.snapshot.audit",
          kind: "FILE",
          classification: "INTERNAL",
          summary: `page ${page.id}: ${elements.length} element(s), ${violations} violation(s)`,
          data: { page: page.id, elements: elements.length, violations, at: ctx.now() },
        });
      } catch (e) {
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while auditing page", detail: e instanceof Error ? e.message : String(e), locator: loc }));
      }
    }

    collector.artifact({ kind: "accessibility-summary", summary: `${audited} page(s) audited`, data: { pagesAudited: audited } });
  }
}
