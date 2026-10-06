// Sandbox child-process runner. Executes exactly ONE synthetic, deterministic task (identified by a
// fixed built-in id) inside the workspace directory the parent created (process.cwd()), reads its
// request from <cwd>/request.json, and writes its outcome to <cwd>/result.json. It is a FIXED project
// script — never arbitrary external code — so it carries no provider-target access. The parent
// enforces the real bounds (timeout -> SIGKILL, controlled env, dedicated workspace, output caps);
// this runner only performs the deterministic task.
//
// Honest limitation (recorded, not hidden): a Node child process is NOT an OS-level jail. It bounds
// time/output/env/cwd and gives an audit trail, but it cannot by itself prevent a task from touching
// the wider filesystem. That is why only trusted, allow-listed synthetic tasks run here; true
// adversarial-code isolation requires a container/VM runtime (see "write-outside" task, which
// measures and REPORTS this limitation rather than relying on it).
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

const cwd = process.cwd();
const requestFile = process.argv[2] || "request.json";

function finish(result) {
  writeFileSync(join(cwd, "result.json"), JSON.stringify(result));
  process.exit(0);
}

let req;
try {
  req = JSON.parse(readFileSync(join(cwd, requestFile), "utf8"));
} catch {
  try { writeFileSync(join(cwd, "result.json"), JSON.stringify({ error: "bad-request" })); } catch {}
  process.exit(10);
}

const input = (req && req.input) || {};

switch (req && req.taskId) {
  case "noop":
    finish({ ok: true });
    break;
  case "echo":
    finish({ echo: input });
    break;
  case "sum":
    finish({ sum: (Array.isArray(input.numbers) ? input.numbers : []).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0) });
    break;
  case "slow": {
    const end = Date.now() + Math.max(0, Number(input.ms) || 0);
    while (Date.now() < end) { /* busy-wait a bounded amount */ }
    finish({ sleptMs: Number(input.ms) || 0 });
    break;
  }
  case "busy-timeout":
    // Never returns on its own: the parent's timeout must SIGKILL it. Proves the time bound works.
    for (;;) { /* spin */ }
  case "throw":
    // Unhandled throw -> non-zero exit + stderr stack, no result.json. Proves crash capture.
    throw new Error(typeof input.message === "string" ? input.message : "intentional-failure");
  case "leak-env": {
    // Report which probe env names are VISIBLE to the child, to prove env isolation from the parent.
    const names = Array.isArray(input.probe) ? input.probe : [];
    const seen = {};
    for (const n of names) seen[n] = typeof process.env[n] === "string";
    finish({ env: seen });
    break;
  }
  case "write-outside": {
    // Attempt to write OUTSIDE the per-run workspace, then clean up, and REPORT whether it was
    // possible. This measures (does not rely on) the Node-child containment limitation honestly.
    const target = resolve(cwd, "..", `escape-probe-${process.pid}.txt`);
    let escaped = false;
    try {
      writeFileSync(target, "probe");
      escaped = !target.startsWith(cwd);
      rmSync(target, { force: true });
    } catch {
      escaped = false;
    }
    finish({ attemptedEscape: true, escapedWorkspace: escaped, note: "Node child is not an OS jail; container/VM needed for true adversarial isolation." });
    break;
  }
  default:
    try { writeFileSync(join(cwd, "result.json"), JSON.stringify({ error: "unknown-task" })); } catch {}
    process.exit(11);
}
