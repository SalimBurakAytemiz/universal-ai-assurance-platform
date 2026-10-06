// Verify the dev/unsigned desktop package: the artifact exists, is non-trivial, carries the real app
// resources (incl. the reviewed view-model bundle), and — the real STARTUP VERIFICATION — the
// PACKAGED UAAP.exe actually RUNS and renders the real repo state (launched with UAAP_SMOKE=1 and
// UAAP_REPO_ROOT pointed at this repo). Emits content-addressed packaging evidence (sha256 + version)
// and exits non-zero on any failure. Fabricates nothing: startup result comes from the packaged
// binary's own VIEWS_RESULT line.
import { existsSync, statSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");
const pkgDir = join(desktopRoot, "dist", "UAAP-win32-x64");
const exe = join(pkgDir, "UAAP.exe");

const fail = (m) => { console.error("PACKAGE_VERIFY_FAIL: " + m); process.exit(1); };

if (!existsSync(exe)) fail("UAAP.exe missing — run `npm run package:dir` first");
const size = statSync(exe).size;
if (size < 1_000_000) fail("UAAP.exe is implausibly small: " + size + " bytes");

for (const rel of [
  "resources/app/src/main.js",
  "resources/app/src/state.js",
  "resources/app/src/views-check.js",
  "resources/app/vendor/desktop-viewmodels.cjs",
  "resources/app/renderer/index.html",
]) {
  if (!existsSync(join(pkgDir, rel))) fail("packaged resource missing: " + rel);
}

const sha = createHash("sha256").update(readFileSync(exe)).digest("hex");
let appPkg = {};
try { appPkg = JSON.parse(readFileSync(join(pkgDir, "resources", "app", "package.json"), "utf8")); } catch { /* best effort */ }
let electronVersion = "unknown";
try { electronVersion = readFileSync(join(pkgDir, "version"), "utf8").trim(); } catch { /* optional */ }

// STARTUP VERIFICATION — run the PACKAGED binary in smoke mode against the real repo.
const run = spawnSync(exe, [], {
  env: { ...process.env, UAAP_SMOKE: "1", UAAP_REPO_ROOT: repoRoot },
  encoding: "utf8", timeout: 120000, windowsHide: true, maxBuffer: 8_000_000,
});
const outText = (run.stdout || "") + "\n" + (run.stderr || "");
const m = /VIEWS_RESULT:(\{.*\})/.exec(outText);
let smoke = null;
try { smoke = m ? JSON.parse(m[1]) : null; } catch { smoke = null; }
const startupOk = run.status === 0 && smoke && smoke.ok === true;

const evidence = {
  artifact: "apps/desktop/dist/UAAP-win32-x64/UAAP.exe",
  sizeBytes: size,
  sha256: sha,
  appName: appPkg.name || "UAAP",
  appVersion: appPkg.version || "unknown",
  electron: electronVersion,
  signed: false,
  startupSmoke: { exitCode: run.status, ok: !!(smoke && smoke.ok), checks: (smoke && smoke.checks) || null, agentsTotal: smoke && smoke.agentsTotal, securityLocked: smoke && smoke.securityLocked },
};
console.log("PACKAGE_EVIDENCE:" + JSON.stringify(evidence));

if (!startupOk) fail("packaged-app startup smoke did NOT pass (exit=" + run.status + ", ok=" + !!(smoke && smoke.ok) + ")");
console.log("PACKAGE_VERIFY_OK");
