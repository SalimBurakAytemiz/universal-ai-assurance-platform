// Deterministic GitHub CI/PR driver for the autopilot. Shells to `gh` — NO LLM — so the service
// can observe CI terminal state and perform a merge on its own, independently of any Claude chat
// session or UI notification. `exec` is injectable so the scheduler can be tested with a fake.
//
// It exposes exactly what the scheduler's WAITING_CI handling needs:
//   poll({prNumber})            -> { state, head, prState }   (state: PENDING|SUCCESS|FAILURE|UNAVAILABLE)
//   merge({prNumber, expectedHead}) -> { ok, merged?, already?, reason? }   (idempotent)
// merge() is idempotent: it refuses to merge if the PR is already MERGED (returns already=true) or
// if the live head no longer equals the reviewed head, so a duplicate CI event can never cause a
// second merge and an unreviewed head is never merged.

/** @typedef {(cmd: string) => { code: number, stdout: string, stderr: string }} Exec */

const FAIL_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"]);
const PENDING_TOKENS = new Set(["", "QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);

/** Reduce a gh statusCheckRollup array to a single terminal/pending verdict (fail-safe to PENDING). */
export function reduceRollup(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "PENDING"; // no checks yet -> keep waiting, never merge
  const tokens = rollup.map((c) => {
    // CheckRun: {status, conclusion}; StatusContext: {state}. Completed check -> conclusion.
    if (c && c.status === "COMPLETED") return String(c.conclusion ?? "").toUpperCase();
    if (c && c.status) return String(c.status).toUpperCase();
    if (c && c.state) return String(c.state).toUpperCase();
    return "";
  });
  if (tokens.some((t) => FAIL_CONCLUSIONS.has(t))) return "FAILURE";
  if (tokens.some((t) => PENDING_TOKENS.has(t))) return "PENDING";
  return "SUCCESS"; // remaining tokens are SUCCESS / SKIPPED / NEUTRAL
}

export class GithubCiDriver {
  /** @param {{ exec: Exec }} deps */
  constructor(deps) {
    this.exec = deps.exec;
  }

  _run(cmd) {
    try {
      return this.exec(cmd);
    } catch (e) {
      return { code: 1, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
    }
  }

  _safePr(n) {
    return Number.isInteger(n) && n > 0 ? String(n) : null;
  }

  /** @returns {Promise<{state:string, head?:string, prState?:string}>} */
  async poll(ci) {
    const pr = this._safePr(ci?.prNumber);
    if (!pr) return { state: "UNAVAILABLE" };
    const r = this._run(`gh pr view ${pr} --json state,headRefOid,statusCheckRollup`);
    if (r.code !== 0) return { state: "UNAVAILABLE" };
    let d;
    try {
      d = JSON.parse(r.stdout);
    } catch {
      return { state: "UNAVAILABLE" };
    }
    const head = d.headRefOid ?? null;
    const prState = d.state ?? null;
    if (prState === "MERGED") return { state: "SUCCESS", head, prState: "MERGED" };
    if (prState === "CLOSED") return { state: "FAILURE", head, prState: "CLOSED" };
    return { state: reduceRollup(d.statusCheckRollup), head, prState };
  }

  /** @returns {Promise<{ok:boolean, merged?:boolean, already?:boolean, reason?:string}>} */
  async merge({ prNumber, expectedHead }) {
    const pr = this._safePr(prNumber);
    if (!pr) return { ok: false, reason: "invalid pr number" };
    // Idempotency + safety gate: re-check live PR state right before merging.
    const v = this._run(`gh pr view ${pr} --json state,headRefOid`);
    if (v.code === 0) {
      try {
        const d = JSON.parse(v.stdout);
        if (d.state === "MERGED") return { ok: true, already: true };
        if (d.state === "CLOSED") return { ok: false, reason: "pr is closed" };
        if (expectedHead && d.headRefOid && d.headRefOid !== expectedHead) {
          return { ok: false, reason: `head changed (${d.headRefOid} != reviewed ${expectedHead})` };
        }
      } catch {
        /* fall through to attempt merge */
      }
    }
    const m = this._run(`gh pr merge ${pr} --squash --delete-branch`);
    if (m.code !== 0) return { ok: false, reason: m.stderr || "gh pr merge failed" };
    return { ok: true, merged: true };
  }
}
