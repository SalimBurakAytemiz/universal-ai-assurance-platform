// Bundle the REVIEWED @uaap/desktop-viewmodels (TS) into a single CJS file the Electron main process
// can require at runtime. This keeps ONE source of truth for the view-model logic (the merged,
// adversarially-reviewed package) instead of the desktop reimplementing it. Output is gitignored and
// rebuilt on demand (dev / smoke / views). esbuild resolves from the repo-root node_modules (Node
// module resolution walks up the directory tree).
import { build } from "esbuild";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "..", "..");
const outdir = join(desktopRoot, "vendor");
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [join(repoRoot, "packages", "desktop-viewmodels", "src", "index.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: join(outdir, "desktop-viewmodels.cjs"),
  logLevel: "info",
});
console.log("bundled @uaap/desktop-viewmodels -> apps/desktop/vendor/desktop-viewmodels.cjs");
