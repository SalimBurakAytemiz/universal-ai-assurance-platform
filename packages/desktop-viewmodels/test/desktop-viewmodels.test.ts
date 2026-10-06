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

/** Deterministic evaluation time for the authorization time-window gate. */
const NOW = Date.parse("2026-10-06T12:00:00Z");
/** A fully IN-FORCE authorization at NOW: a complete @uaap/core AuthorizationRecord — active mode,
 * bound target, explicit identifier/domain/environment scope, and a current [notBefore, notAfter)
 * window. Anything less (missing a scope field, wrong mode, or an expired/future window) must NOT
 * unlock active validation. */
const GENUINE_AUTH = {
  id: "AUTH-1",
  mode: "CLIENT_AUTHORIZED",
  targetId: "t1",
  allowedIdentifiers: ["host.example.test"],
  maxActionClass: "R1_LOW_IMPACT",
  allowedEnvironments: ["STAGING"],
  allowedDomains: ["SECURITY"],
  notBefore: "2026-10-01T00:00:00Z",
  notAfter: "2026-12-01T00:00:00Z",
  grantedBy: "owner:test-human",
  reference: "signed-artifact://test/AUTH-1",
};

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

  it("security posture reads ENABLED only with a real, scoped, in-force authorization record", () => {
    const authed = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [GENUINE_AUTH] } }), NOW);
    expect(authed.locked).toBe(false);
    expect(authed.inconsistency).toBeNull();
  });

  it("FAIL-CLOSED: an authorization that is well-shaped but NOT in force (expired/future/wrong-mode/missing-scope) never unlocks", () => {
    // Round-2 regression: the genuineness check validated only id/targetId/allowedIdentifiers and
    // ignored the window/mode/scope the kernel enforces, so an expired record read as ENABLED.
    const expired = { ...GENUINE_AUTH, notBefore: "2020-01-01T00:00:00Z", notAfter: "2020-01-02T00:00:00Z" };
    const future = { ...GENUINE_AUTH, notBefore: "2099-01-01T00:00:00Z", notAfter: "2099-02-01T00:00:00Z" };
    const passiveMode = { ...GENUINE_AUTH, mode: "PROSPECT_PASSIVE" };
    const noDomain = { ...GENUINE_AUTH, allowedDomains: [] as string[] };
    const noEnv = { ...GENUINE_AUTH, allowedEnvironments: [] as string[] };
    const badWindow = { ...GENUINE_AUTH, notAfter: "not-a-date" };
    // Round-3 regression: a passive-only ceiling (R0_PASSIVE) authorizes ZERO active actions
    // (kernel Gate 7), so it must not unlock active validation even though it is otherwise complete.
    const passiveCeiling = { ...GENUINE_AUTH, maxActionClass: "R0_PASSIVE" };
    for (const rec of [expired, future, passiveMode, noDomain, noEnv, badWindow, passiveCeiling]) {
      const vm = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [rec] } }), NOW);
      expect(vm.authorizationsPresent).toBe(false);
      expect(vm.locked).toBe(true);
      expect(vm.inconsistency).toMatch(/no genuine scoped authorization record is currently in force/);
    }
    // but the fix mirrors the kernel: an ABSENT or garbage maxActionClass still unlocks (the kernel's
    // Gate 7 `1 > undefined` is false → R1 permitted), so we must NOT over-lock those.
    for (const mac of [undefined, "R9_GARBAGE", "R2_ELEVATED", "R3_PROHIBITED"]) {
      const rec = { ...GENUINE_AUTH, maxActionClass: mac } as Record<string, unknown>;
      if (mac === undefined) delete rec.maxActionClass;
      const vm = securityPostureViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [rec] } }), NOW);
      expect(vm.locked).toBe(false);
    }
    // and the home badge must not show ENABLED for an expired record either
    const h = homeViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [expired] } }), NOW);
    expect(h.activeSecurityValidation).toBe("LOCKED_BY_DESIGN");
    expect(h.securityLocked).toBe(true);
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
    // but a genuine, in-force authorization DOES surface the real enabled state on home
    const hAuthed = homeViewModel(state({ master: { activeSecurityValidation: { state: "ENABLED" } }, authorizations: { authorizations: [GENUINE_AUTH] } }), NOW);
    expect(hAuthed.activeSecurityValidation).toBe("ENABLED");
    expect(hAuthed.securityLocked).toBe(false);
  });

  it("build-graph view-models never CRASH on a null/malformed node and never mislabel unknown status as NOT_STARTED", () => {
    // Round-2 regression: buildGraphViewModel's families map dereferenced a null node (crash), and
    // the malformed-status fallback was "NOT_STARTED" (a real status) instead of "UNKNOWN".
    const s = state({ buildGraph: { nodes: [
      null as unknown as RepoState["buildGraph"]["nodes"][number],
      { id: "a", name: "A", family: "core", status: "DONE" },
      { id: "x", name: "X", family: "quality" } as unknown as RepoState["buildGraph"]["nodes"][number], // no status
    ] } });
    const b = buildGraphViewModel(s); // must not throw
    expect(b.families).toEqual(["core", "quality"]); // null node contributes no family, no crash
    expect(b.counts.DONE).toBe(1);
    expect(b.counts.UNKNOWN).toBe(2); // the null node + the missing-status node — NOT counted as NOT_STARTED
    expect(b.counts.NOT_STARTED).toBeUndefined();
    const h = homeViewModel(s, NOW);
    expect(h.nodes.notStarted).toBe(0); // unknown status never inflates the real NOT_STARTED bucket
    expect(h.nodes.done).toBe(1);
    expect(h.nodes.total).toBe(3);
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
