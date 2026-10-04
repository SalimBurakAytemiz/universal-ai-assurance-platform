#!/usr/bin/env node
// Session-independent autopilot CLI. Runs as a plain Node process — NO build step, NO Claude
// session required. Lifecycle: start | stop | pause | resume | status | recover.
//
//   node services/autopilot/cli.mjs start     # run the deterministic scheduler loop (foreground)
//   node services/autopilot/cli.mjs status    # one-shot status (JSON)
//   node services/autopilot/cli.mjs recover    # reload durable state, reset interrupted jobs
//   node services/autopilot/cli.mjs pause|resume|stop
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync, openSync, closeSync, writeSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JobStore } from "./lib/store.mjs";
import { ProviderGate, defaultProbe } from "./lib/provider.mjs";
import { GitCiMonitor } from "./lib/monitor.mjs";
import { AutopilotService } from "./lib/service.mjs";
import { acquireInstanceLock, releaseInstanceLock, liveInstanceHeld } from "./lib/instancelock.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AI_DIR = join(REPO_ROOT, ".ai", "autopilot");
const JOBS_PATH = join(AI_DIR, "jobs.json");
const PID_PATH = join(AI_DIR, "autopilot.pid");
const PROVIDER_PATH = join(AI_DIR, "provider.json");

const realClock = { now: () => new Date().toISOString() };
const exec = (cmd) => {
  try {
    return { code: 0, stdout: execSync(cmd, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString?.() ?? "", stderr: e.stderr?.toString?.() ?? String(e) };
  }
};

function build() {
  const store = new JobStore(JOBS_PATH);
  const providerGate = new ProviderGate({ probe: () => defaultProbe(PROVIDER_PATH) });
  const service = new AutopilotService({ store, providerGate, clock: realClock });
  const monitor = new GitCiMonitor({ exec });
  return { store, providerGate, service, monitor };
}

async function main() {
  const cmd = process.argv[2] ?? "status";
  mkdirSync(AI_DIR, { recursive: true });
  const { store, service, monitor, providerGate } = build();

  switch (cmd) {
    case "start": {
      // Single-instance guard (atomic acquire + stale reclaim).
      if (!acquireInstanceLock(PID_PATH)) {
        console.error(`[autopilot] another live instance holds ${PID_PATH}. Refusing to start a second loop.`);
        process.exitCode = 3;
        break;
      }
      service.resume();
      const release = () => releaseInstanceLock(PID_PATH);
      process.on("SIGINT", () => { service.stop(); });
      process.on("SIGTERM", () => { service.stop(); });
      console.log(`[autopilot] started pid=${process.pid}; provider=${providerGate.isAvailable()}; jobs=${store.list().length}`);
      // Deterministic monitoring each tick (no LLM): snapshot git/PR/CI to .ai/autopilot/monitor.json.
      const beforeTick = async () => {
        const branch = monitor.currentBranch();
        const snap = { at: realClock.now(), branch, head: monitor.headSha(), pr: branch ? monitor.prStatus(branch) : null, ci: branch ? monitor.ciStatus(branch) : null };
        try { writeFileSync(join(AI_DIR, "monitor.json"), JSON.stringify(snap, null, 2) + "\n"); } catch { /* ignore */ }
      };
      await service.startLoop(5000, { beforeTick });
      release();
      console.log("[autopilot] stopped");
      break;
    }
    case "stop": service.stop(); console.log("[autopilot] stop requested (running loop will exit)"); break;
    case "pause": service.pause(); console.log("[autopilot] paused"); break;
    case "resume": service.resume(); console.log("[autopilot] resumed"); break;
    case "recover": {
      // Mutating command: refuse to run concurrently with a live start loop (single writer).
      if (liveInstanceHeld(PID_PATH)) {
        console.error("[autopilot] a live instance is running; it recovers on its own cycle. Not running a second recover.");
        process.exitCode = 3; break;
      }
      if (!acquireInstanceLock(PID_PATH)) { console.error("[autopilot] could not acquire instance lock for recover."); process.exitCode = 3; break; }
      try { const r = await service.recover(); console.log(JSON.stringify({ recovered: true, ...r }, null, 2)); }
      finally { releaseInstanceLock(PID_PATH); }
      break;
    }
    case "status": {
      const branch = monitor.currentBranch();
      console.log(JSON.stringify({
        ...service.status(),
        git: { branch, head: monitor.headSha() },
        pidFile: existsSync(PID_PATH),
      }, null, 2));
      break;
    }
    default:
      console.error(`Unknown command "${cmd}". Use: start|stop|pause|resume|status|recover`);
      process.exitCode = 2;
  }
}

main().catch((e) => { console.error("[autopilot] fatal:", e); process.exitCode = 1; });
