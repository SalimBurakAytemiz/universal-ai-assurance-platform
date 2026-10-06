import { parse } from "node:path";
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

/** A structurally-genuine, scoped authorization record (id + bound target + explicit scope). */
const GENUINE_AUTH = { id: "AUTH-1", targetId: "t1", allowedIdentifiers: ["host.example.test"] };

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
    expect(sneaky.inconsistency).toMatch(/no genuine scoped authorization/); // and the inconsistency is surfaced, not hidden
  });

  it("security posture reads ENABLED only with a real, scoped authorization record", () => {
    const authed = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [GENUINE_AUTH] } }));
    expect(authed.locked).toBe(false);
    expect(authed.inconsistency).toBeNull();
  });

  it("FAIL-CLOSED allow-list: an UNKNOWN/typo'd state never unlocks, even with a genuine authorization", () => {
    // Regression: locked previously used a deny-list (=== LOCKED_BY_DESIGN), so any non-sentinel
    // state value with any auth array read as UNLOCKED. Only an explicit ENABLED may unlock.
    for (const sneakyState of ["DETECTION_ONLY", "PENDING", "DISABLED", "enabled", "ENABLED ", ""]) {
      const vm = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: sneakyState } }, authorizations: { authorizations: [GENUINE_AUTH] } }));
      expect(vm.locked).toBe(true);
      expect(vm.inconsistency).toMatch(/unrecognized active-validation state|no genuine scoped authorization/);
    }
  });

  it("FAIL-CLOSED: placeholder/malformed authorization entries do NOT count as a real authorization", () => {
    // Regression: authorizationsPresent was `Array.isArray && length > 0`, so [{}]/[null]/[0] etc.
    // masqueraded as a genuine authorization and unlocked active validation.
    for (const junk of [[{}], [null], [0], [""], [false], [{ id: "AUTH-1" }], [{ id: "AUTH-1", targetId: "t1" }], [{ id: "", targetId: "t1", allowedIdentifiers: ["x"] }], [{ id: "A", targetId: "t1", allowedIdentifiers: [] }]]) {
      const vm = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: junk as unknown[] } }));
      expect(vm.authorizationsPresent).toBe(false);
      expect(vm.locked).toBe(true);
      expect(vm.inconsistency).toMatch(/no genuine scoped authorization/);
    }
  });

  it("NO FAKE GREEN on home: the home badge is auth-gated, never a raw unbacked ENABLED string", () => {
    // Regression: homeViewModel passed through master.activeSecurityValidation.state verbatim, so an
    // unbacked "ENABLED" rendered as a green badge while securityPosture correctly reported locked.
    const h = homeViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [] } }));
    expect(h.activeSecurityValidation).toBe("LOCKED_BY_DESIGN");
    expect(h.securityLocked).toBe(true);
    expect(h.securityInconsistency).toMatch(/no genuine scoped authorization/);
    // but a genuine authorization DOES surface the real enabled state on home
    const hAuthed = homeViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [GENUINE_AUTH] } }));
    expect(hAuthed.activeSecurityValidation).toBe("ENABLED");
    expect(hAuthed.securityLocked).toBe(false);
  });

  it("parseTestStatus anchors to the authoritative '## Last local run' section, ignoring stale/aspirational lines", () => {
    // Regression: a non-global exec returned the FIRST doc match, so an earlier aspirational number
    // would be shown as the current status.
    const md = [
      "# TEST STATUS",
      "Aspirational target: **500 passed / 500** across 40 files (someday).",
      "## Old run — 2026-01-01",
      "- vitest: **100 passed / 120** across 10 files",
      "## Last local run — 2026-10-06",
      "- vitest: **424 passed / 424** across 35 files (real)",
    ].join("\n");
    expect(parseTestStatus(md)).toEqual({ passed: 424, total: 424, files: 35 });
  });

  it("loadRepoState degrades to honest defaults when the repo root cannot be located (never throws)", () => {
    // Regression: findRepoRoot() was outside try/catch; from a non-repo dir (here the filesystem
    // root, cross-platform via node:path) it propagated and crashed the entire data layer.
    const fsRoot = parse(process.cwd()).root;
    const s = loadRepoState(fsRoot);
    expect(s.buildGraph.nodes).toEqual([]);
    expect(s.testStatus).toBeNull();
    expect(s.authorizations.authorizations).toEqual([]);
    // and the derived view-models are honest + fail-closed off those defaults
    const vm = allViewModels(s);
    expect(vm.home.nodes.total).toBe(0);
    expect(vm.securityPosture.locked).toBe(true);
    expect(vm.home.activeSecurityValidation).toBe("LOCKED_BY_DESIGN");
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
