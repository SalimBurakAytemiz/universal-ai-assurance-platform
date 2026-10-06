// Reproducible LIVE capture smoke: drives the installed Chrome (Playwright) against LOCAL HTML
// fixtures, captures each step, routes the captured flow through the fail-closed @uaap/quality-web-engine,
// and asserts the engine surfaces the planted issues on the broken fixture and ZERO on the clean one.
// Run from the package with:  npm run live   (bundles the adapter first). Exits non-zero on failure.
// Nothing is fabricated: findings come from the engine over what the real browser actually captured.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { captureAndValidate } from "./_adapter.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => join(here, "..", "fixtures", n);
function out(o) { process.stdout.write("LIVE_RESULT:" + JSON.stringify(o) + "\n"); }

try {
  const broken = await captureAndValidate({
    id: "broken-login",
    steps: [{ action: "navigate", goto: fixture("broken.html"), requires: [{ selector: "#submit" }], forbids: [".error-banner"] }],
  });
  const bKinds = new Set(broken.result.findings.map((f) => f.kind));

  const clean = await captureAndValidate({
    id: "clean-login",
    steps: [{ action: "navigate", goto: fixture("clean.html"), requires: [{ selector: "#hero", expectVisible: true }, { selector: "#submit", expectVisible: true }], forbids: [".error-banner"] }],
  });

  const checks = {
    brokenMissingRequired: bKinds.has("required-element-missing"),
    brokenForbiddenPresent: bKinds.has("forbidden-element-present"),
    brokenConsoleError: bKinds.has("console-error"),
    cleanZeroFindings: clean.result.findings.length === 0,
  };
  const ok = Object.values(checks).every(Boolean);
  out({ ok, checks, brokenFindings: [...bKinds], cleanFindings: clean.result.findings.length });
  process.exit(ok ? 0 : 3);
} catch (e) {
  out({ ok: false, error: (e && e.message) ? e.message.split("\n")[0] : String(e) });
  process.exit(1);
}
