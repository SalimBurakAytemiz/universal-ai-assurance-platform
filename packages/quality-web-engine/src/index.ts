// @uaap/quality-web-engine — a FUNCTIONAL web/UI assurance engine on the @uaap/engine-core lifecycle.
// It runs deterministic checks over RECORDED web-interaction artifacts (an ordered "flow" of steps,
// each with the URL reached, required/forbidden elements, recorded console messages and recorded
// network requests). Its scope is functional web automation — navigation correctness, required-
// element presence, forbidden-element (error state) detection, console errors, network failures and
// recorded step outcome — DISTINCT from the accessibility engine (WCAG over snapshots), the API
// engine (contract checks) and the performance engine (latency/error budgets).
//
// OFFLINE-ONLY and fail-closed BY CONSTRUCTION:
//   * It inspects artifacts that were ALREADY captured (local fixtures today; a Playwright capture
//     transport, gated behind the tool broker + an authorization, later). No browser is driven here,
//     there is no Agent → Target, and there is nothing to authorize. The live capture is the gated
//     part; this validation logic is not.
//   * A clean flow yields zero findings; malformed input is surfaced per-item, never crashes the run.
//   * NO FAKE GREEN: a requirement with no recorded evidence of presence is reported as UNVERIFIABLE,
//     never silently treated as satisfied. A navigation with an expected URL but no recorded actual
//     URL is likewise unverifiable, not a pass.
//   * SECRET-SAFE: URLs are echoed with their query string and fragment STRIPPED (that is where
//     tokens / PII live, per the platform's no-secrets-in-URLs rule), and recorded console/request
//     bodies are NEVER echoed — only levels, statuses, methods and counts.
import {
  CancellationToken,
  EngineAbort,
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

/** A recorded reference to an element that a step requires to be present (or forbids). */
export interface WebElementRef {
  readonly selector?: string;
  readonly role?: string;
  readonly name?: string;
  /** Whether the capturer OBSERVED the element present. `undefined` = not recorded (unverifiable). */
  readonly present?: boolean;
  /** Whether the element was visible (only checked for required elements that were present). */
  readonly visible?: boolean;
}
export interface WebConsoleEntry {
  readonly level?: string;
  /** Message text is intentionally NOT inspected or echoed (it may contain secrets/PII). */
  readonly text?: string;
}
export interface WebNetworkEntry {
  readonly url?: string;
  readonly method?: string;
  readonly status?: number;
  /** Explicit success/failure flags the capturer may have recorded. */
  readonly ok?: boolean;
  readonly failed?: boolean;
  readonly resourceType?: string;
}
export interface WebStep {
  readonly action?: string;
  /** The URL reached AFTER this step (as recorded). */
  readonly url?: string;
  /** The expected URL after this step; may end with "*" for a prefix match. */
  readonly expectedUrl?: string;
  /** Navigation HTTP status recorded for this step (if any). */
  readonly status?: number;
  /** Elements that MUST be present after this step. */
  readonly requires?: readonly WebElementRef[];
  /** Elements that must NOT be present (e.g. an error banner). */
  readonly forbids?: readonly WebElementRef[];
  readonly console?: readonly WebConsoleEntry[];
  readonly network?: readonly WebNetworkEntry[];
  /** Recorded step outcome, if the capturer set it. `false` => the step itself failed. */
  readonly ok?: boolean;
}
export interface WebFlow {
  readonly id: string;
  readonly steps: readonly WebStep[];
}
export interface WebEngineInput {
  readonly flows: readonly WebFlow[];
}

const SEV = { P0: "P0", P1: "P1", P2: "P2", P3: "P3" } as const;
/** Console levels that count as an error. `assert` is here because console.assert() emits a message
 * ONLY when its assertion FAILS (a passing assert emits nothing), so a recorded `assert` is an error
 * signal — never benign. A truly unrecognized level is surfaced separately (fail-closed). */
const CONSOLE_ERROR_LEVELS = new Set(["error", "severe", "fatal", "critical", "assert"]);
/** Non-error console levels — every standard console API / Playwright ConsoleMessage.type() value
 * that is informational, so a clean flow that merely uses console.table/dir/group/etc. yields ZERO
 * findings. (`assert` is deliberately NOT here — see CONSOLE_ERROR_LEVELS.) */
const CONSOLE_BENIGN_LEVELS = new Set([
  "log", "info", "debug", "trace", "warn", "warning", "verbose", "notice",
  "dir", "dirxml", "table", "clear", "count", "countreset",
  "group", "groupcollapsed", "groupend", "startgroup", "startgroupcollapsed", "endgroup",
  "profile", "profileend", "time", "timelog", "timeend", "timestamp",
]);

/** Echo a URL with its query, fragment AND userinfo (basic-auth `user:pass@`) removed — all three
 * can carry tokens/PII. SECRET-SAFE BY CONSTRUCTION and biased toward over-stripping: the userinfo
 * is removed FIRST (before query/fragment) by scanning the authority (from after `[scheme:]//` up to
 * the first `/`) to the LAST `@`, so a credential containing a raw `@`, `?` or `#` is fully dropped —
 * a password embedded in a recorded URL can never reach a finding. A relative URL (no `//`) and a
 * path that merely contains `@` (after the first `/`) are left intact. */
function safeUrl(u: unknown): string {
  if (typeof u !== "string" || u.trim() === "") return "(no url)";
  let s = u;
  const scheme = /^([a-z][a-z0-9+.-]*:)?\/\//i.exec(s);
  if (scheme) {
    const start = scheme[0].length;
    const slash = s.indexOf("/", start);
    const authEnd = slash === -1 ? s.length : slash; // authority ends at the first '/' (NOT '?'/'#', so a credential with those is still inside it)
    const authority = s.slice(start, authEnd);
    const at = authority.lastIndexOf("@");
    if (at !== -1) s = s.slice(0, start) + authority.slice(at + 1) + s.slice(authEnd);
  }
  s = s.split("#")[0]!.split("?")[0]!;
  return s.length > 0 ? s : "(empty url)";
}
function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "";
}
function describeRef(ref: WebElementRef): string {
  if (isNonEmptyString(ref.role) && isNonEmptyString(ref.name)) return `${ref.role} "${ref.name}"`;
  if (isNonEmptyString(ref.selector)) return ref.selector;
  if (isNonEmptyString(ref.role)) return `role=${ref.role}`;
  if (isNonEmptyString(ref.name)) return `"${ref.name}"`;
  return "(unidentified element)";
}
/** Exact match, or prefix match when `expected` ends with "*". Both inputs are already path-only. */
function urlMatches(expected: string, actual: string): boolean {
  if (expected.endsWith("*")) return actual.startsWith(expected.slice(0, -1));
  return expected === actual;
}

export class QualityWebEngine implements ExecutionEngine {
  capabilities(): EngineCapabilities {
    return {
      engineId: "qa.web-engine",
      domain: "QUALITY",
      version: "0.1.0",
      capabilities: [
        "web.navigation-correctness",
        "web.required-element",
        "web.forbidden-element",
        "web.console-errors",
        "web.network-failures",
        "web.step-outcome",
      ],
      offlineOnly: true,
    };
  }
  health(): EngineHealth {
    return { status: HealthStatus.HEALTHY };
  }

  private input(ctx: EngineContext): WebEngineInput {
    return ctx.input as WebEngineInput;
  }
  private flowsOf(ctx: EngineContext): readonly WebFlow[] {
    const f = (this.input(ctx) as { flows?: unknown })?.flows;
    return Array.isArray(f) ? (f as WebFlow[]) : [];
  }

  /** Read a flow id defensively — a hostile/throwing accessor yields undefined, never a thrown error
   * out of discover/plan (which would fail the whole run instead of being isolated in execute). */
  private safeId(f: unknown): unknown {
    try {
      return f && typeof f === "object" ? (f as { id?: unknown }).id : undefined;
    } catch {
      return undefined;
    }
  }
  discover(ctx: EngineContext): Discovery {
    const flows = this.flowsOf(ctx);
    return { items: flows.map((f) => this.safeId(f)), summary: `${flows.length} recorded web flow(s)` };
  }
  plan(ctx: EngineContext, _d: Discovery): EnginePlan {
    const flows = this.flowsOf(ctx);
    return { steps: flows.map((f) => ({ flow: this.safeId(f) })), summary: `audit ${flows.length} flow(s)` };
  }
  validatePrereqs(ctx: EngineContext, _p: EnginePlan): PrereqResult {
    const input = this.input(ctx);
    const missing: string[] = [];
    if (!input || typeof input !== "object") missing.push("input is missing");
    else if (!Array.isArray(input.flows) || input.flows.length === 0) missing.push("flows is empty");
    return missing.length === 0 ? { ok: true } : { ok: false, missing };
  }

  execute(ctx: EngineContext, _plan: EnginePlan, token: CancellationToken, collector: EngineCollector): void {
    let audited = 0;
    const flows = this.flowsOf(ctx);
    const seenFlowIds = new Set<string>();
    for (const flow of flows) {
      token.throwIfCancelled();
      // The entire per-flow body — INCLUDING the identity/shape read — is inside try/catch so even a
      // hostile object (e.g. a throwing `id` getter) is isolated to this one flow and never aborts
      // the run. A genuine cancellation/timeout (EngineAbort) is re-thrown so the driver can finalize.
      try {
        if (!(flow && typeof flow === "object" && typeof flow.id === "string")) {
          collector.finding(finding({ severity: SEV.P2, kind: "malformed-flow", title: "Malformed web flow", detail: "A flow is null or has no string id; skipped.", locator: "flows" }));
          continue;
        }
        if (seenFlowIds.has(flow.id)) {
          collector.finding(finding({ severity: SEV.P2, kind: "duplicate-flow", title: "Duplicate flow id", detail: `Flow id "${flow.id}" appears more than once; the later one is ignored (first kept).`, locator: `flow ${flow.id}` }));
          continue;
        }
        seenFlowIds.add(flow.id);
        const floc = `flow ${flow.id}`;
        audited++;
        let violations = 0;
        const add = (f: EngineFinding) => {
          violations++;
          collector.finding(f);
        };
        const steps = Array.isArray(flow.steps) ? flow.steps : [];
        if (!Array.isArray(flow.steps)) add(finding({ severity: SEV.P2, kind: "malformed-flow", title: "Flow has no steps array", detail: `Flow "${flow.id}" has no steps array; its step rules could not run.`, locator: floc }));
        else if (steps.length === 0) add(finding({ severity: SEV.P2, kind: "empty-flow", title: "Empty web flow", detail: `Flow "${flow.id}" has zero steps; nothing could be verified (not a pass).`, locator: floc }));

        steps.forEach((step, i) => {
          token.throwIfCancelled(); // checkpoint between steps (each step is a unit of work)
          const sloc = `${floc} step[${i}]`;
          if (!step || typeof step !== "object") {
            add(finding({ severity: SEV.P2, kind: "malformed-step", title: "Malformed step", detail: `Step ${i} is null or not an object; skipped.`, locator: sloc }));
            return;
          }

          // Recorded step outcome.
          if (step.ok === false) add(finding({ severity: SEV.P1, kind: "step-failed", title: "Recorded step failed", detail: `Step ${i}${isNonEmptyString(step.action) ? ` (${step.action})` : ""} was recorded as failed.`, locator: sloc }));

          // Navigation correctness (only when an expected URL is declared).
          if (isNonEmptyString(step.expectedUrl)) {
            const actual = typeof step.url === "string" ? step.url : undefined;
            if (actual === undefined) {
              add(finding({ severity: SEV.P2, kind: "navigation-unverifiable", title: "Navigation not verifiable", detail: `Step ${i} expects URL "${safeUrl(step.expectedUrl)}" but no actual URL was recorded; cannot confirm navigation (not a pass).`, locator: sloc }));
            } else if (!urlMatches(safeUrl(step.expectedUrl), safeUrl(actual))) {
              add(finding({ severity: SEV.P1, kind: "navigation-mismatch", title: "Navigation landed on the wrong URL", detail: `Step ${i} expected "${safeUrl(step.expectedUrl)}" but reached "${safeUrl(actual)}".`, locator: sloc }));
            }
          }
          // Navigation status (when recorded).
          if (typeof step.status === "number" && Number.isFinite(step.status) && step.status >= 400) {
            add(finding({ severity: step.status >= 500 ? SEV.P1 : SEV.P2, kind: "navigation-error-status", title: "Navigation returned an error status", detail: `Step ${i} navigation returned HTTP ${step.status} for "${safeUrl(step.url)}".`, locator: sloc }));
          }

          // Required elements.
          const requires: readonly WebElementRef[] = Array.isArray(step.requires) ? step.requires : [];
          if (step.requires !== undefined && !Array.isArray(step.requires)) add(finding({ severity: SEV.P2, kind: "malformed-step", title: "Step requires is not an array", detail: `Step ${i} has a non-array \`requires\`; required-element checks skipped.`, locator: sloc }));
          requires.forEach((ref, j) => {
            if (!ref || typeof ref !== "object") {
              add(finding({ severity: SEV.P3, kind: "malformed-requirement", title: "Malformed required element", detail: `Step ${i} requires[${j}] is null or not an object; skipped.`, locator: sloc }));
              return;
            }
            if (ref.present === false) add(finding({ severity: SEV.P1, kind: "required-element-missing", title: "Required element missing", detail: `Step ${i} requires ${describeRef(ref)} but it was not present.`, locator: sloc }));
            else if (ref.present === undefined || ref.present === null) add(finding({ severity: SEV.P2, kind: "requirement-unverifiable", title: "Required element not verifiable", detail: `Step ${i} requires ${describeRef(ref)} but its presence was not recorded; cannot confirm (not a pass).`, locator: sloc }));
            else if (ref.present === true) {
              if (ref.visible === false) add(finding({ severity: SEV.P2, kind: "required-element-not-visible", title: "Required element present but not visible", detail: `Step ${i} requires ${describeRef(ref)}; it is present but was recorded as not visible.`, locator: sloc }));
            } else add(finding({ severity: SEV.P3, kind: "malformed-requirement", title: "Malformed required element presence", detail: `Step ${i} requires ${describeRef(ref)} with a non-boolean \`present\`; cannot confirm (not a pass).`, locator: sloc }));
          });

          // Forbidden elements (e.g. an error banner that must not appear).
          const forbids: readonly WebElementRef[] = Array.isArray(step.forbids) ? step.forbids : [];
          if (step.forbids !== undefined && !Array.isArray(step.forbids)) add(finding({ severity: SEV.P2, kind: "malformed-step", title: "Step forbids is not an array", detail: `Step ${i} has a non-array \`forbids\`; forbidden-element checks skipped.`, locator: sloc }));
          forbids.forEach((ref, j) => {
            if (!ref || typeof ref !== "object") {
              add(finding({ severity: SEV.P3, kind: "malformed-forbidden", title: "Malformed forbidden element", detail: `Step ${i} forbids[${j}] is null or not an object; skipped.`, locator: sloc }));
              return;
            }
            if (ref.present === true) add(finding({ severity: SEV.P1, kind: "forbidden-element-present", title: "Forbidden element present", detail: `Step ${i} forbids ${describeRef(ref)} but it was present (e.g. an error/blocked state).`, locator: sloc }));
            else if (ref.present === undefined || ref.present === null) add(finding({ severity: SEV.P2, kind: "forbidden-unverifiable", title: "Forbidden element absence not verifiable", detail: `Step ${i} forbids ${describeRef(ref)} but its presence was not recorded; cannot confirm absence (not a pass).`, locator: sloc }));
            else if (ref.present !== false) add(finding({ severity: SEV.P3, kind: "malformed-forbidden", title: "Malformed forbidden element presence", detail: `Step ${i} forbids ${describeRef(ref)} with a non-boolean \`present\`; cannot confirm absence (not a pass).`, locator: sloc }));
          });

          // Console errors (level only — message text is never inspected or echoed).
          const consoleEntries: readonly WebConsoleEntry[] = Array.isArray(step.console) ? step.console : [];
          if (step.console !== undefined && !Array.isArray(step.console)) add(finding({ severity: SEV.P2, kind: "malformed-step", title: "Step console is not an array", detail: `Step ${i} has a non-array \`console\`; console checks skipped.`, locator: sloc }));
          let consoleErrors = 0;
          consoleEntries.forEach((c, j) => {
            const level = typeof c?.level === "string" ? c.level.toLowerCase().trim() : "";
            if (CONSOLE_ERROR_LEVELS.has(level)) consoleErrors++;
            else if (level === "" || !CONSOLE_BENIGN_LEVELS.has(level)) add(finding({ severity: SEV.P3, kind: "unknown-console-level", title: "Unrecognized console level", detail: `Step ${i} console[${j}] has an unrecognized level "${level || "(empty)"}"; treated as not-benign (surfaced, not ignored).`, locator: sloc }));
          });
          if (consoleErrors > 0) add(finding({ severity: SEV.P2, kind: "console-error", title: "Console error(s) recorded", detail: `Step ${i} recorded ${consoleErrors} console error-level message(s).`, locator: sloc }));

          // Network failures (url echoed query-stripped; body never echoed).
          const network: readonly WebNetworkEntry[] = Array.isArray(step.network) ? step.network : [];
          if (step.network !== undefined && !Array.isArray(step.network)) add(finding({ severity: SEV.P2, kind: "malformed-step", title: "Step network is not an array", detail: `Step ${i} has a non-array \`network\`; network checks skipped.`, locator: sloc }));
          network.forEach((req, j) => {
            if (!req || typeof req !== "object") {
              add(finding({ severity: SEV.P3, kind: "malformed-network", title: "Malformed network entry", detail: `Step ${i} network[${j}] is null or not an object; skipped.`, locator: sloc }));
              return;
            }
            const method = isNonEmptyString(req.method) ? req.method.toUpperCase() : "GET";
            const hasStatus = typeof req.status === "number" && Number.isFinite(req.status);
            if (req.failed === true || (hasStatus && (req.status as number) >= 500)) {
              add(finding({ severity: SEV.P1, kind: "network-request-failed", title: "Network request failed", detail: `Step ${i}: ${method} "${safeUrl(req.url)}" ${hasStatus ? `returned HTTP ${req.status}` : "failed"}.`, locator: sloc }));
            } else if (hasStatus && (req.status as number) >= 400) {
              add(finding({ severity: SEV.P2, kind: "network-request-client-error", title: "Network request client error", detail: `Step ${i}: ${method} "${safeUrl(req.url)}" returned HTTP ${req.status}.`, locator: sloc }));
            } else if (req.ok === false) {
              // A recorded not-ok is a failure REGARDLESS of status (a 2xx/3xx flagged not-ok is still
              // a failure the capturer saw) — never gate this on the absence of a status code.
              add(finding({ severity: SEV.P2, kind: "network-request-not-ok", title: "Network request recorded not-ok", detail: `Step ${i}: ${method} "${safeUrl(req.url)}" was recorded as not ok${hasStatus ? ` (HTTP ${req.status})` : ""}.`, locator: sloc }));
            }
          });
        });

        collector.evidence({
          producedBy: "qa.web-engine",
          action: "web.flow.audit",
          kind: "FILE",
          classification: "INTERNAL",
          summary: `flow ${flow.id}: ${steps.length} step(s), ${violations} violation(s)`,
          data: { flow: flow.id, steps: steps.length, violations, at: ctx.now() },
        });
      } catch (e) {
        if (e instanceof EngineAbort) throw e; // a real cancellation/timeout must reach the driver, not be swallowed as a finding
        collector.finding(finding({ severity: SEV.P2, kind: "engine-error", title: "Engine error while auditing flow", detail: e instanceof Error ? e.message : String(e), locator: "flows" }));
      }
    }

    collector.artifact({ kind: "web-summary", summary: `${audited} flow(s) audited`, data: { flowsAudited: audited } });
  }
}
