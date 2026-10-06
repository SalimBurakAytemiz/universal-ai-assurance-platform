// @uaap/sandbox-learning — a SAFE, LOCAL, bounded execution sandbox for the platform's own synthetic
// learning / evaluation tasks. It is the local alternative to a container runtime (Docker is not
// available on this host): it runs a FIXED project runner script in an isolated Node child process
// with real resource + workspace + environment bounds, captures artifacts, produces an
// evaluation-shaped outcome, writes an audit trail, and cleans up deterministically.
//
// FAIL-CLOSED by construction:
//   * Only task ids explicitly listed in the policy's `allowedTasks` run; everything else => DENIED
//     (an empty allow-list denies everything).
//   * A controlled environment is built from an allow-list — the child never inherits the parent's
//     secrets. No production/provider target access is granted.
//   * A dedicated per-run temp workspace is the child's cwd; it is removed after the run.
//   * A wall-clock timeout SIGKILLs a runaway task (it can never hang the caller).
//   * stdout/stderr are size-capped.
//
// HONEST LIMITATION (recorded, not hidden): a Node child process bounds time/output/env/cwd and gives
// an audit trail, but it is NOT an OS-level jail — it cannot by itself stop a task from touching the
// wider filesystem (the built-in "write-outside" probe task measures and reports this). That is why
// ONLY trusted, allow-listed synthetic tasks run here; true adversarial-code isolation needs a
// container/VM runtime. `audit.osLevelIsolation` is always false to make this explicit.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashObject, newId } from "@uaap/core";
import type { CaseOutcome } from "@uaap/agent-evaluation";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "runner.mjs");

/** The built-in, trusted, deterministic synthetic tasks the runner can execute. */
export const BUILTIN_TASKS = ["noop", "echo", "sum", "slow", "busy-timeout", "throw", "leak-env", "write-outside"] as const;
export type BuiltinTask = (typeof BUILTIN_TASKS)[number];

export const SandboxStatus = {
  COMPLETED: "COMPLETED",
  TIMED_OUT: "TIMED_OUT",
  FAILED: "FAILED",
  DENIED: "DENIED",
} as const;
export type SandboxStatus = (typeof SandboxStatus)[keyof typeof SandboxStatus];

export interface SandboxLimits {
  /** Wall-clock budget; past it the child is SIGKILLed. */
  readonly timeoutMs: number;
  /** Max bytes captured from stdout+stderr combined (spawn maxBuffer). */
  readonly maxOutputBytes: number;
}

export interface SandboxPolicy {
  readonly limits: SandboxLimits;
  /** Base directory for per-run workspaces. Defaults to the OS temp dir. */
  readonly workspaceRoot?: string;
  /** Parent env var names the child MAY see (besides the OS-essential minimum). Default: none. */
  readonly envAllowlist?: readonly string[];
  /** Task ids permitted to run. Empty/absent => everything is DENIED (fail-closed). */
  readonly allowedTasks: readonly string[];
  /** Keep the workspace after the run (debugging). Default false (deterministic cleanup). */
  readonly keepWorkspace?: boolean;
}

export interface SandboxRequest {
  readonly taskId: string;
  readonly input?: unknown;
}

export interface SandboxAudit {
  readonly id: string;
  readonly taskId: string;
  readonly inputHash: string;
  readonly limits: SandboxLimits;
  readonly envKeys: readonly string[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: SandboxStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  /** ALWAYS false: a Node-child sandbox is not an OS jail (documented limitation). */
  readonly osLevelIsolation: false;
}

export interface SandboxResult {
  readonly status: SandboxStatus;
  readonly result: unknown;
  readonly stdout: string;
  readonly stderr: string;
  readonly reason?: string;
  readonly audit: SandboxAudit;
}

/** OS env vars the child genuinely needs to start (platform-aware); never includes app secrets. */
function osEssentialEnv(): Record<string, string> {
  const keys = process.platform === "win32"
    ? ["SystemRoot", "windir", "TEMP", "TMP", "PATHEXT", "NUMBER_OF_PROCESSORS", "COMSPEC"]
    : ["PATH", "LANG", "LC_ALL", "TMPDIR"];
  const out: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

export interface RunOptions {
  /** Injected clock for deterministic audit timestamps (defaults to Date.now via new Date()). */
  now?: () => Date;
}

/** Minimal structured audit for the outer backstop when the normal path cannot even start. */
function fallbackAudit(startedIso: string, t0: number): SandboxAudit {
  let id = "SBX_error";
  try { id = newId("SBX"); } catch { /* keep the fallback id */ }
  return { id, taskId: "", inputHash: "", limits: { timeoutMs: 0, maxOutputBytes: 0 }, envKeys: [], startedAt: startedIso, finishedAt: startedIso, status: SandboxStatus.FAILED, exitCode: null, signal: null, durationMs: Math.max(0, Date.now() - t0), stdoutBytes: 0, stderrBytes: 0, osLevelIsolation: false };
}

/**
 * Run one request in the sandbox. TOTAL BY CONSTRUCTION: an outer backstop guarantees this NEVER
 * throws to the caller — a denied task, a timeout, a crash, a bad workspace, a spawn error, a null
 * opts, a hostile request getter, anything — all map to a structured SandboxResult. Partial output is
 * preserved. The workspace is always cleaned up (unless policy.keepWorkspace) even on failure.
 */
export function runSandboxed(request: SandboxRequest, policy: SandboxPolicy, opts: RunOptions = {}): SandboxResult {
  const t0 = Date.now();
  const startedIso = new Date().toISOString();
  try {
    return runSandboxedInner(request, policy, opts);
  } catch (e) {
    // Extract the message under its OWN guard: a hostile thrown value (throwing toString /
    // Symbol.toPrimitive / message getter) must not make the backstop itself throw. This is the last
    // conversion in the total-by-construction chain.
    let msg = "unknown error";
    try { msg = e instanceof Error ? e.message : String(e); } catch { msg = "unstringifiable error"; }
    if (typeof msg !== "string") msg = "non-string error";
    return { status: SandboxStatus.FAILED, result: null, stdout: "", stderr: "", reason: `sandbox error: ${msg}`, audit: fallbackAudit(startedIso, t0) };
  }
}

function runSandboxedInner(request: SandboxRequest, policy: SandboxPolicy, opts: RunOptions): SandboxResult {
  // Defensive opts/clock: a null opts, or a bad injected now() (throwing, or `new Date(NaN)` whose
  // toISOString throws), must NOT break the TOTAL contract — fall back to a real timestamp.
  const o = opts && typeof opts === "object" ? opts : {};
  const rawNow = o.now ?? (() => new Date());
  const nowIso = (): string => {
    try {
      const s = rawNow().toISOString();
      return typeof s === "string" ? s : new Date().toISOString();
    } catch {
      return new Date().toISOString();
    }
  };
  // Defensive policy: a null/malformed policy must resolve structurally (DENIED/FAILED), never throw.
  const pol = (policy && typeof policy === "object" ? policy : {}) as SandboxPolicy;
  const startedAt = nowIso();
  const t0 = Date.now();
  let taskId = "";
  try { taskId = request && typeof request.taskId === "string" ? request.taskId : ""; } catch { taskId = ""; }
  // Guard: a non-serializable input (BigInt, circular ref) must NOT make the function throw — the
  // contract is TOTAL. Fall back to a sentinel hash so the request still resolves structurally.
  let inputHash: string;
  try {
    inputHash = hashObject(request ? request.input ?? null : null);
  } catch {
    inputHash = "unserializable";
  }

  // Clamp limits (read defensively off a possibly-absent policy.limits) to finite, in-range values
  // so a malformed policy can never make spawnSync throw.
  const rawLimits = (pol.limits && typeof pol.limits === "object" ? pol.limits : {}) as Partial<SandboxLimits>;
  const timeoutMs = Number.isFinite(rawLimits.timeoutMs as number) ? Math.max(1, Math.floor(rawLimits.timeoutMs as number)) : 1;
  const maxBuffer = Number.isFinite(rawLimits.maxOutputBytes as number) ? Math.max(1024, Math.floor(rawLimits.maxOutputBytes as number)) : 1024;
  const normLimits: SandboxLimits = { timeoutMs, maxOutputBytes: maxBuffer };

  const envEssential = osEssentialEnv();
  const allow = Array.isArray(pol.envAllowlist) ? pol.envAllowlist : [];
  for (const k of allow) {
    const v = process.env[k];
    if (typeof v === "string") envEssential[k] = v;
  }
  const envKeys = Object.keys(envEssential).sort();

  const mkAudit = (status: SandboxStatus, exitCode: number | null, signal: string | null, outB: number, errB: number): SandboxAudit => ({
    id: newId("SBX"),
    taskId,
    inputHash,
    limits: normLimits,
    envKeys,
    startedAt,
    finishedAt: nowIso(),
    status,
    exitCode,
    signal,
    durationMs: Date.now() - t0,
    stdoutBytes: outB,
    stderrBytes: errB,
    osLevelIsolation: false,
  });

  // Gate 1: allow-list (fail-closed).
  const allowed = Array.isArray(pol.allowedTasks) ? pol.allowedTasks : [];
  if (!taskId || !allowed.includes(taskId)) {
    return { status: SandboxStatus.DENIED, result: null, stdout: "", stderr: "", reason: taskId ? `task "${taskId}" is not in the policy allow-list` : "missing taskId", audit: mkAudit(SandboxStatus.DENIED, null, null, 0, 0) };
  }

  // Gate 2: dedicated workspace.
  let workspace: string;
  try {
    const root = pol.workspaceRoot ?? tmpdir();
    if (!existsSync(root)) mkdirSync(root, { recursive: true });
    workspace = mkdtempSync(join(root, "uaap-sbx-"));
  } catch (e) {
    return { status: SandboxStatus.FAILED, result: null, stdout: "", stderr: "", reason: `workspace creation failed: ${e instanceof Error ? e.message : String(e)}`, audit: mkAudit(SandboxStatus.FAILED, null, null, 0, 0) };
  }

  try {
    // Serialize the request safely: a non-serializable input cannot run the task -> FAILED, not throw.
    let payload: string;
    try {
      payload = JSON.stringify({ taskId, input: request.input ?? {} });
    } catch (e) {
      return { status: SandboxStatus.FAILED, result: null, stdout: "", stderr: "", reason: `request input is not JSON-serializable: ${e instanceof Error ? e.message : String(e)}`, audit: mkAudit(SandboxStatus.FAILED, null, null, 0, 0) };
    }
    writeFileSync(join(workspace, "request.json"), payload);
    const run = spawnSync(process.execPath, [RUNNER, "request.json"], {
      cwd: workspace,
      env: envEssential, // CONTROLLED: only OS-essential + allow-listed keys; no inherited secrets
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer,
      windowsHide: true,
      encoding: "utf8",
    });

    const stdout = typeof run.stdout === "string" ? run.stdout : "";
    const stderr = typeof run.stderr === "string" ? run.stderr : "";
    const outB = Buffer.byteLength(stdout);
    const errB = Buffer.byteLength(stderr);
    const errCode = run.error ? (run.error as NodeJS.ErrnoException).code : undefined;

    // Classify by the ACTUAL cause — never conflate them (the signal is SIGKILL for both timeout and
    // maxBuffer breach, so we key on error.code, not the signal, for an honest audit trail).
    if (errCode === "ETIMEDOUT") {
      return { status: SandboxStatus.TIMED_OUT, result: null, stdout, stderr, reason: `exceeded ${timeoutMs}ms budget`, audit: mkAudit(SandboxStatus.TIMED_OUT, run.status, run.signal ?? "SIGKILL", outB, errB) };
    }
    if (errCode === "ENOBUFS") {
      return { status: SandboxStatus.FAILED, result: null, stdout, stderr, reason: `output exceeded the ${maxBuffer}-byte cap`, audit: mkAudit(SandboxStatus.FAILED, run.status, run.signal ?? "SIGKILL", outB, errB) };
    }
    if (run.error) {
      return { status: SandboxStatus.FAILED, result: null, stdout, stderr, reason: `spawn error: ${run.error.message}`, audit: mkAudit(SandboxStatus.FAILED, run.status, run.signal, outB, errB) };
    }

    // Read the result artifact the runner wrote.
    let result: unknown = null;
    let haveResult = false;
    try {
      const rp = join(workspace, "result.json");
      if (existsSync(rp)) { result = JSON.parse(readFileSync(rp, "utf8")); haveResult = true; }
    } catch { haveResult = false; }

    if (run.status !== 0 || !haveResult) {
      return { status: SandboxStatus.FAILED, result: haveResult ? result : null, stdout, stderr, reason: run.status !== 0 ? `non-zero exit ${run.status}` : "no result artifact produced", audit: mkAudit(SandboxStatus.FAILED, run.status, run.signal, outB, errB) };
    }
    // The runner reports an application error inside result.json (e.g. unknown-task) — treat as FAILED.
    if (result && typeof result === "object" && "error" in (result as Record<string, unknown>)) {
      return { status: SandboxStatus.FAILED, result, stdout, stderr, reason: `runner error: ${String((result as Record<string, unknown>).error)}`, audit: mkAudit(SandboxStatus.FAILED, run.status, run.signal, outB, errB) };
    }
    return { status: SandboxStatus.COMPLETED, result, stdout, stderr, audit: mkAudit(SandboxStatus.COMPLETED, run.status, run.signal, outB, errB) };
  } catch (e) {
    // TOTAL guarantee: any unexpected throw (IO error on write, spawn arg error) -> structured FAILED.
    return { status: SandboxStatus.FAILED, result: null, stdout: "", stderr: "", reason: `sandbox error: ${e instanceof Error ? e.message : String(e)}`, audit: mkAudit(SandboxStatus.FAILED, null, null, 0, 0) };
  } finally {
    if (!pol.keepWorkspace) {
      try { rmSync(workspace, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
    }
  }
}

export interface EvalCaseSpec {
  readonly id: string;
  readonly request: SandboxRequest;
  /** Deep-equality expectation for `result` when the run COMPLETES. */
  readonly expect?: unknown;
  /** True if this case is EXPECTED to end in a non-COMPLETED status (timeout/crash/denied). */
  readonly expectNonCompletion?: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  // Guarded: `spec.expect` is arbitrary caller input and may be non-serializable (circular/BigInt).
  // A non-serializable expectation can never equal the always-JSON-safe run.result, so treat a
  // stringify failure as not-equal rather than letting it throw out of evaluateCase.
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** True when the run reported a workspace-containment ESCAPE (the one limitation a Node-child sandbox
 * has). Derived from the actual result, never assumed. */
function reportedEscape(run: SandboxResult): boolean {
  return !!(run.result && typeof run.result === "object" && (run.result as Record<string, unknown>).escapedWorkspace === true);
}

/**
 * Run an evaluation case in the sandbox and map it to an agent-evaluation CaseOutcome. `correct` is
 * true when the observed status + result match the spec's expectation. `policyCompliant` is DERIVED
 * from the real outcome: it is false when the run reported a containment escape (escapedWorkspace) —
 * so the one limitation the sandbox admits can surface in the certification metric rather than being
 * masked by a hardcoded constant. latencyMs is the real measured duration. Wires the sandbox into the
 * certification pipeline (aggregateMetrics).
 */
export function evaluateCase(spec: EvalCaseSpec, policy: SandboxPolicy, opts: RunOptions = {}): { outcome: CaseOutcome; run: SandboxResult } {
  // Guard spec the same defensive way runSandboxed guards its params, so a malformed/null spec yields
  // a structured CaseOutcome instead of throwing — the public surface is total on both functions.
  const s = (spec && typeof spec === "object" ? spec : {}) as EvalCaseSpec;
  const run = runSandboxed(s.request, policy, opts);
  const completed = run.status === SandboxStatus.COMPLETED;
  const correct = s.expectNonCompletion
    ? !completed
    : completed && (s.expect === undefined || deepEqual(run.result, s.expect));
  const outcome: CaseOutcome = {
    id: typeof s.id === "string" ? s.id : "",
    correct,
    policyCompliant: !reportedEscape(run), // honest: a demonstrated containment escape is NOT compliant
    evidenceOk: run.audit != null,
    latencyMs: run.audit.durationMs,
    tokenCost: 0,
  };
  return { outcome, run };
}
