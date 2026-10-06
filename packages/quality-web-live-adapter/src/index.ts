// @uaap/quality-web-live-adapter — the LIVE capture front-end for the offline @uaap/quality-web-engine.
// It drives a real browser (Playwright over the installed Chrome) against a LOCAL fixture ONLY,
// captures what happened (navigation, element presence/visibility, console levels, network metadata),
// converts it into the engine's recorded-artifact format (a WebFlow), and routes it through the
// fail-closed engine. There is NO external/customer target: a non-local URL is REFUSED by construction
// (isLocalTarget allow-list) BEFORE any browser launches, so this can never touch a provider target.
//
// Design split so the pure logic is CI-testable WITHOUT a browser:
//   * isLocalTarget / toLocalUrl / validateCapturedFlow are pure (unit-tested in the root suite).
//   * driveAndCaptureFlow dynamically imports playwright-core (never loaded unless a live drive runs),
//     so CI (no browser) imports this module and tests the pure path with zero browser dependency.
//   * The real browser drive is validated by the committed local smoke (smoke/live-capture.mjs).
import { pathToFileURL } from "node:url";
import { driveEngine, type EngineContext, type EngineResult } from "@uaap/engine-core";
import {
  QualityWebEngine,
  type WebConsoleEntry,
  type WebElementRef,
  type WebFlow,
  type WebNetworkEntry,
  type WebStep,
} from "@uaap/quality-web-engine";

/** Loopback / local hostnames permitted for http(s) and resolved file: hosts. */
function isLocalHost(hostname: string): boolean {
  const h = (hostname || "").toLowerCase();
  return h === "" || h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]" || h.endsWith(".localhost") || h.endsWith(".test");
}

/** FAIL-CLOSED allow-list: only genuinely LOCAL targets may be driven. Everything else is refused —
 * crucially including anything that resolves to a REMOTE authority (UNC \\host, protocol-relative
 * //host, file://host, or an http(s) non-loopback host) which could become an SSRF / SMB credential
 * leak. */
export function isLocalTarget(target: string): boolean {
  if (typeof target !== "string") return false;
  const t = target.trim();
  if (t === "") return false;
  if (t.startsWith("data:")) return true;
  // REFUSE UNC / protocol-relative authority paths outright: \\host\.. and //host/.. point at a
  // REMOTE host (on Windows, Chrome loads them as SMB — SSRF + NTLM leak).
  if (t.startsWith("\\\\") || t.startsWith("//")) return false;
  // Local filesystem paths: Windows drive (C:\ or C:/), POSIX absolute (single /), or relative.
  if (/^[a-zA-Z]:[\\/]/.test(t)) return true;
  if (t.startsWith("/") || t.startsWith("./") || t.startsWith("../")) return true;
  try {
    const u = new URL(t);
    // file: is local ONLY when it carries no remote authority (host empty / loopback) AND its path is
    // NOT a UNC-style //host/share form — `file:////host/share` parses to an EMPTY host but Chrome on
    // Windows loads the //host path as the SMB share \\host\share (SSRF / NTLM leak).
    if (u.protocol === "file:") return isLocalHost(u.hostname) && !u.pathname.startsWith("//");
    if (u.protocol === "http:" || u.protocol === "https:") return isLocalHost(u.hostname);
    return false;
  } catch {
    // Not an absolute URL and not a recognized path form — a bare relative path ONLY if it carries no
    // URL scheme (fail-closed: anything scheme-like is refused).
    return !/^[a-z][a-z0-9+.-]*:/i.test(t);
  }
}

/** Convert a local fixture path or URL to a URL string the browser can load. Throws if non-local. */
export function toLocalUrl(target: string): string {
  if (!isLocalTarget(target)) throw new Error(`live adapter refuses a non-local target: ${String(target)}`);
  const t = target.trim();
  if (t.startsWith("data:") || /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || t.startsWith("file:")) return t;
  const url = pathToFileURL(t).href; // a bare path -> file:// URL
  // Defense-in-depth: a path must never resolve to a file URL with a remote authority.
  try {
    if (!isLocalHost(new URL(url).hostname)) throw new Error(`live adapter refuses a path that resolves to a remote host: ${String(target)}`);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("live adapter")) throw e;
  }
  return url;
}

export interface CaptureElementSpec {
  readonly selector: string;
  readonly expectVisible?: boolean;
}
export interface CaptureStepSpec {
  readonly action?: string;
  /** Local URL/path to navigate to at the start of this step. */
  readonly goto?: string;
  /** Expected URL after this step (passed through to the engine; "*"-suffix glob supported there). */
  readonly expectedUrl?: string;
  /** Selector to click after navigation. */
  readonly click?: string;
  /** Elements that must be present (and optionally visible). */
  readonly requires?: readonly CaptureElementSpec[];
  /** Elements that must NOT be present. */
  readonly forbids?: readonly string[];
}
export interface CaptureSpec {
  readonly id: string;
  readonly steps: readonly CaptureStepSpec[];
  /** Per-step wall-clock budget (ms). */
  readonly timeoutMs?: number;
}

/** Route an already-captured WebFlow through the fail-closed engine. PURE — no browser. */
export async function validateCapturedFlow(flow: WebFlow, now: () => string = () => new Date().toISOString()): Promise<EngineResult> {
  const ctx: EngineContext = { runId: "RUN-LIVE", input: { flows: [flow] }, now };
  return driveEngine(new QualityWebEngine(), ctx);
}

/**
 * Drive a real browser (installed Chrome via Playwright) against LOCAL targets, capturing each step
 * into a WebStep. Refuses any non-local target before launching. Secret-safe: it captures console
 * LEVELS only (never message text) and network URL/status/method (the engine redacts the URL on echo).
 * Requires playwright-core + a Chrome install at RUNTIME; dynamically imported so this is never a load
 * dependency of the pure path / CI.
 */
export async function driveAndCaptureFlow(spec: CaptureSpec): Promise<WebFlow> {
  // Refuse non-local targets up-front (fail-closed) before any browser launches.
  for (const s of spec.steps) {
    if (s.goto && !isLocalTarget(s.goto)) throw new Error(`live adapter refuses a non-local target: ${String(s.goto)}`);
  }
  // Cast the dynamically-imported browser surface to `any`: it is RUNTIME-only (never loaded in CI /
  // the pure path), so we deliberately keep typecheck independent of playwright-core's exact types.
  const { chromium } = (await import("playwright-core")) as { chromium: any };
  const timeout = typeof spec.timeoutMs === "number" && spec.timeoutMs > 0 ? spec.timeoutMs : 5000;
  const browser: any = await chromium.launch({ channel: "chrome", headless: true });
  const steps: WebStep[] = [];
  try {
    const page: any = await browser.newPage();
    // NETWORK GUARD (fail-closed): abort ANY request — initial navigation, redirect target, click
    // navigation, or subresource — whose URL is not local. This enforces "local only" for EVERY
    // navigation, not just the initial goto, so a 3xx/meta/JS redirect or a link to a remote host
    // cannot cause an external fetch.
    await page.route("**/*", (route: any) => {
      let reqUrl = "";
      try { reqUrl = route.request().url(); } catch { reqUrl = ""; }
      // Allow inherently-local, non-network schemes (in-memory / same-origin) in addition to the
      // local-target allow-list, so a legitimate local page's blob:/about:/data: subresource is not
      // spuriously aborted. These never reach a remote host.
      const localScheme = /^(blob:|about:|data:|filesystem:)/i.test(reqUrl);
      if (localScheme || isLocalTarget(reqUrl)) route.continue();
      else route.abort();
    });
    // Presence helpers: on a thrown/failed check return undefined (UNVERIFIABLE) — never coerce an
    // error to a definite boolean (that would let the engine silently pass/mislabel it).
    const presenceOf = async (sel: string): Promise<boolean | undefined> => {
      try { return !!(await page.$(sel)); } catch { return undefined; }
    };
    const visibleOf = async (sel: string): Promise<boolean | undefined> => {
      try { return await page.isVisible(sel); } catch { return undefined; }
    };
    for (const s of spec.steps) {
      const consoleEntries: WebConsoleEntry[] = [];
      const network: WebNetworkEntry[] = [];
      const onConsole = (m: { type: () => string }) => consoleEntries.push({ level: m.type() }); // LEVEL only — never text
      const onResp = (r: { url: () => string; status: () => number; request: () => { method: () => string } }) => network.push({ url: r.url(), status: r.status(), method: r.request().method() });
      const onFail = (r: { url: () => string; request: () => { method: () => string } }) => network.push({ url: r.url(), method: r.request().method(), failed: true });
      page.on("console", onConsole);
      page.on("response", onResp);
      page.on("requestfailed", onFail);

      let url: string | undefined;
      let status: number | undefined;
      let ok = true;
      try {
        if (s.goto) {
          const resp = await page.goto(toLocalUrl(s.goto), { waitUntil: "load", timeout });
          url = page.url();
          status = resp ? resp.status() : undefined;
        }
        if (s.click) await page.click(s.click, { timeout });
        // Post-navigation locality check (belt-and-suspenders beyond the route guard): if the page
        // somehow ended up on a non-local URL, treat the step as failed rather than capturing remote state.
        const landed = page.url();
        if (typeof landed === "string" && landed !== "about:blank" && !isLocalTarget(landed)) ok = false;
      } catch {
        ok = false;
      }

      const requires: WebElementRef[] = [];
      for (const r of s.requires || []) {
        const present = await presenceOf(r.selector);
        const visible = present === true ? await visibleOf(r.selector) : undefined;
        requires.push({ selector: r.selector, present, visible });
      }
      const forbids: WebElementRef[] = [];
      for (const sel of s.forbids || []) {
        const present = await presenceOf(sel); // undefined on error => engine surfaces forbidden-unverifiable (not a silent pass)
        forbids.push({ selector: sel, present });
      }

      page.off("console", onConsole);
      page.off("response", onResp);
      page.off("requestfailed", onFail);

      const step: WebStep = { action: s.action, url, expectedUrl: s.expectedUrl, status, requires, forbids, console: consoleEntries, network, ok };
      steps.push(step);
    }
  } finally {
    await browser.close();
  }
  return { id: spec.id, steps };
}

/** Drive a local fixture AND validate the captured flow in one call. */
export async function captureAndValidate(spec: CaptureSpec): Promise<{ flow: WebFlow; result: EngineResult }> {
  const flow = await driveAndCaptureFlow(spec);
  const result = await validateCapturedFlow(flow);
  return { flow, result };
}
