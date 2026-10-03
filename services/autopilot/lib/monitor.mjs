// Deterministic Git/GitHub/PR/CI monitor. Shells out to `git` and `gh` — NO LLM involved — so
// the autopilot can observe repository and CI state on its own. `exec` is injectable for tests.

/** @typedef {(cmd: string) => { code: number, stdout: string, stderr: string }} Exec */

export class GitCiMonitor {
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

  currentBranch() {
    const r = this._run("git rev-parse --abbrev-ref HEAD");
    return r.code === 0 ? r.stdout.trim() : null;
  }

  headSha() {
    const r = this._run("git rev-parse HEAD");
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /** @returns {{bound:boolean, number?:number, state?:string}} */
  prStatus(branch) {
    const r = this._run(`gh pr view ${branch} --json number,state`);
    if (r.code !== 0) return { bound: false };
    try {
      const d = JSON.parse(r.stdout);
      return { bound: true, number: d.number, state: d.state };
    } catch {
      return { bound: false };
    }
  }

  /**
   * @returns {{available:boolean, allPass?:boolean, checks?:Array<{name:string,state:string}>}}
   * Deterministic reduction of `gh pr checks --json` into a pass/pending/fail summary.
   */
  ciStatus(branch) {
    const r = this._run(`gh pr checks ${branch} --json name,state`);
    if (r.code !== 0) return { available: false };
    try {
      const checks = JSON.parse(r.stdout);
      if (!Array.isArray(checks) || checks.length === 0) return { available: true, allPass: false, checks: [] };
      const allPass = checks.every((c) => c.state === "SUCCESS");
      return { available: true, allPass, checks: checks.map((c) => ({ name: c.name, state: c.state })) };
    } catch {
      return { available: false };
    }
  }
}
