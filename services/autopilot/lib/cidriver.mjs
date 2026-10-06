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
const PASS_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]); // the ONLY completed conclusions that pass
const PENDING_TOKENS = new Set(["", "QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]);

/**
 * Reduce a gh statusCheckRollup to SUCCESS / PENDING / FAILURE, FAIL-CLOSED on vocabulary.
 * SUCCESS requires EVERY check to be a recognized pass (SUCCESS/NEUTRAL/SKIPPED). An unknown
 * conclusion on a COMPLETED check is NOT a pass — it maps to FAILURE (it will not change by waiting
 * and must never be mistaken for green). An unknown status on a still-running check maps to PENDING.
 * Empty / no checks => PENDING (never merge with nothing to go on).
 */
export function reduceRollup(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "PENDING"; // no checks yet -> keep waiting, never merge
  let sawFail = false;
  let sawPending = false;
  for (const c of rollup) {
    const completed = !!c && c.status === "COMPLETED";
    const token = (completed ? String(c.conclusion ?? "") : String((c && (c.status ?? c.state)) ?? "")).toUpperCase();
    if (FAIL_CONCLUSIONS.has(token)) sawFail = true;
    else if (completed) {
      if (!PASS_CONCLUSIONS.has(token)) sawFail = true; // completed with an UNRECOGNIZED conclusion -> fail-closed
    } else if (PENDING_TOKENS.has(token)) sawPending = true;
    else sawPending = true; // unknown status on a non-completed check -> keep waiting
  }
  if (sawFail) return "FAILURE";
  if (sawPending) return "PENDING";
  return "SUCCESS"; // every check is a recognized pass
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

  /**
   * Idempotent, FAIL-CLOSED safe-merge. Returns {ok,merged?,already?} on success, else
   * {ok:false, retryable, reason}. retryable=true means a transient/unverifiable condition the
   * scheduler should retry (keep WAITING_CI); retryable=false is a definitive safety refusal
   * (PR closed, or the live head no longer matches the reviewed head) the scheduler must BLOCK on.
   * The merge command runs ONLY after the live PR state is positively confirmed OPEN with
   * headRefOid === expectedHead, and is additionally pinned with --match-head-commit so GitHub
   * rejects it atomically if the head moved in the TOCTOU window.
   */
  async merge({ prNumber, expectedHead }) {
    const pr = this._safePr(prNumber);
    if (!pr) return { ok: false, retryable: false, reason: "invalid pr number" };
    // Positively confirm live state before merging — never fall through to merge on an unverifiable
    // pre-check (that would risk merging a closed PR or an unreviewed head).
    const v = this._run(`gh pr view ${pr} --json state,headRefOid`);
    if (v.code !== 0) return { ok: false, retryable: true, reason: "cannot verify PR state before merge" };
    let d;
    try {
      d = JSON.parse(v.stdout);
    } catch {
      return { ok: false, retryable: true, reason: "unparseable PR state before merge" };
    }
    if (d.state === "MERGED") return { ok: true, already: true };
    if (d.state === "CLOSED") return { ok: false, retryable: false, reason: "pr is closed" };
    if (expectedHead) {
      if (!d.headRefOid) return { ok: false, retryable: true, reason: "cannot verify PR head before merge" };
      if (d.headRefOid !== expectedHead) return { ok: false, retryable: false, reason: `head changed (${d.headRefOid} != reviewed ${expectedHead})` };
    }
    // Pin to the reviewed SHA (defense-in-depth against a last-moment head change).
    const pin = this._safeSha(expectedHead) ? ` --match-head-commit ${expectedHead}` : "";
    const m = this._run(`gh pr merge ${pr} --squash --delete-branch${pin}`);
    if (m.code !== 0) return { ok: false, retryable: true, reason: m.stderr || "gh pr merge failed" };
    return { ok: true, merged: true };
  }

  _safeSha(s) {
    return typeof s === "string" && /^[0-9a-fA-F]{7,40}$/.test(s) ? s : null;
  }
}
