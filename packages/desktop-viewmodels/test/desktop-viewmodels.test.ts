import { describe, it, expect } from "vitest";
import {
  agentsViewModel,
  allViewModels,
  buildGraphViewModel,
  homeViewModel,
  loadRepoState,
  parseTestStatus,
  reviewsViewModel,
  securityPostureViewModel,
  type RepoState,
} from "@uaap/desktop-viewmodels";

function state(over: Partial<RepoState> = {}): RepoState {
  return {
    master: { product: "UAAP", canonicalAgents: { defined: 72, certified: 0 }, activeSecurityValidation: { state: "LOCKED_BY_DESIGN" }, lastCheckpoint: { commit: "abc123" } },
    buildGraph: { nodes: [
      { id: "a", name: "A", family: "core", status: "DONE" },
      { id: "b", name: "B", family: "core", status: "DONE" },
      { id: "c", name: "C", family: "quality", status: "READY" },
      { id: "d", name: "D", family: "security", status: "BLOCKED" },
      { id: "e", name: "E", family: "desktop", status: "NOT_STARTED" },
    ] },
    review: { unresolved: { P0: 0, P1: 0, P2: 0, P3: 0 }, lastReview: { confirmed: 3 }, boundedLoop: { count: 2, max: 3 } },
    agents: { agents: [{ id: "gov.x", guild: "COMMAND_AND_GOVERNANCE", status: "DRAFT" }, { id: "qa.y", guild: "QUALITY", status: "DRAFT" }] },
    skills: { skills: [1, 2, 3] },
    authorizations: { authorizations: [] },
    testStatus: { passed: 416, total: 416, files: 34 },
    ...over,
  };
}

describe("desktop view-models — derived from real state", () => {
  it("home reflects the real node counts, test status, and checkpoint", () => {
    const h = homeViewModel(state());
    expect(h.nodes).toEqual({ done: 2, ready: 1, blocked: 1, notStarted: 1, total: 5 });
    expect(h.tests).toEqual({ passed: 416, total: 416, files: 34 });
    expect(h.lastCheckpointCommit).toBe("abc123");
  });

  it("buildGraph groups nodes by status and lists families", () => {
    const b = buildGraphViewModel(state());
    expect(b.byStatus.DONE?.map((n) => n.id)).toEqual(["a", "b"]);
    expect(b.byStatus.BLOCKED?.map((n) => n.id)).toEqual(["d"]);
    expect(b.families).toEqual(["core", "desktop", "quality", "security"]);
  });

  it("agents certified count comes from the authoritative state, not inferred", () => {
    const a = agentsViewModel(state({ master: { canonicalAgents: { certified: 0 } } }));
    expect(a.total).toBe(2);
    expect(a.certified).toBe(0); // zero certified until the certification layer says otherwise
    expect(a.byGuild.QUALITY).toBe(1);
  });

  it("NO FAKE GREEN: blocked nodes and unresolved findings are surfaced, not hidden", () => {
    const s = state({ review: { unresolved: { P0: 1, P1: 0, P2: 2, P3: 0 } } });
    expect(homeViewModel(s).nodes.blocked).toBe(1);
    const r = reviewsViewModel(s);
    expect(r.allResolved).toBe(false); // there are open findings
    // and when tests were never recorded, the view shows unknown, not a fabricated pass
    expect(homeViewModel(state({ testStatus: null })).tests).toBeNull();
  });

  it("security posture is FAIL-CLOSED: no authorization => locked, even if state claims otherwise", () => {
    expect(securityPostureViewModel(state()).locked).toBe(true); // LOCKED_BY_DESIGN + no auth
    const sneaky = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [] } }));
    expect(sneaky.locked).toBe(true); // claims ENABLED but no auth => still locked
    expect(sneaky.inconsistency).toMatch(/no authorization/); // and the inconsistency is surfaced, not hidden
  });

  it("security posture reads ENABLED only with a real authorization record", () => {
    const authed = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [{ id: "AUTH-1" }] } }));
    expect(authed.locked).toBe(false);
    expect(authed.inconsistency).toBeNull();
  });

  it("parseTestStatus parses the recorded line, returns null when absent", () => {
    expect(parseTestStatus("- vitest: **416 passed / 416** across 34 files (x)")).toEqual({ passed: 416, total: 416, files: 34 });
    expect(parseTestStatus("no test line here")).toBeNull();
  });

  it("smoke: loads the REAL repo state and derives honest view-models", () => {
    const vm = allViewModels(loadRepoState());
    expect(vm.home.nodes.done).toBeGreaterThan(0);
    expect(vm.agents.total).toBe(72); // the real 72-agent registry
    expect(vm.securityPosture.locked).toBe(true); // no authorization exists in the repo
    expect(vm.home.activeSecurityValidation).toBe("LOCKED_BY_DESIGN");
  });
});
