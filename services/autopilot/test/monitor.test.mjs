import { describe, it, expect } from "vitest";
import { GitCiMonitor } from "../lib/monitor.mjs";

function fakeExec(map) {
  return (cmd) => {
    for (const [pattern, out] of Object.entries(map)) {
      if (cmd.includes(pattern)) return out;
    }
    return { code: 1, stdout: "", stderr: "unknown cmd" };
  };
}

describe("GitCiMonitor (deterministic, no LLM)", () => {
  it("reads branch and head SHA", () => {
    const m = new GitCiMonitor({
      exec: fakeExec({
        "rev-parse --abbrev-ref HEAD": { code: 0, stdout: "auto/x\n", stderr: "" },
        "rev-parse HEAD": { code: 0, stdout: "abc123\n", stderr: "" },
      }),
    });
    expect(m.currentBranch()).toBe("auto/x");
    expect(m.headSha()).toBe("abc123");
  });

  it("reduces CI checks to allPass", () => {
    const pass = new GitCiMonitor({ exec: fakeExec({ "pr checks": { code: 0, stdout: JSON.stringify([{ name: "ci", state: "SUCCESS" }]), stderr: "" } }) });
    expect(pass.ciStatus("b").allPass).toBe(true);
    const fail = new GitCiMonitor({ exec: fakeExec({ "pr checks": { code: 0, stdout: JSON.stringify([{ name: "ci", state: "FAILURE" }]), stderr: "" } }) });
    expect(fail.ciStatus("b").allPass).toBe(false);
  });

  it("fails safe when gh/git are unavailable", () => {
    const m = new GitCiMonitor({ exec: () => { throw new Error("gh not found"); } });
    expect(m.currentBranch()).toBeNull();
    expect(m.prStatus("b").bound).toBe(false);
    expect(m.ciStatus("b").available).toBe(false);
  });
});
