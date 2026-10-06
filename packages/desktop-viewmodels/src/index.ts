// @uaap/desktop-viewmodels — the data layer behind the desktop views. It derives typed view-models
// from the REAL repository/runtime state (.ai/*, the agent/skill registries, the recorded test
// status) and NOTHING ELSE: there is no hardcoded "green", no fabricated count, no optimistic
// default. Every value a view shows traces to a state field; where state is absent the view-model
// says "unknown", never "ok". Security posture is FAIL-CLOSED: active validation reads as LOCKED
// unless the real state says otherwise AND an authorization actually exists.
//
// These are pure functions (+ a fromRepo loader), so they are fully unit-testable without launching
// Electron. The renderer consumes them; the renderer's actual rendering is validated when the
// desktop app is run.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot, readRepoJson } from "@uaap/core";

export interface BuildGraphNodeState {
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly status: string;
}
export interface TestStatus {
  readonly passed: number | null;
  readonly total: number | null;
  readonly files: number | null;
}
export interface RepoState {
  readonly master: {
    readonly product?: string;
    readonly canonicalAgents?: { readonly defined?: number; readonly certified?: number };
    readonly activeSecurityValidation?: { readonly state?: string };
    readonly lastCheckpoint?: { readonly commit?: string };
  };
  readonly buildGraph: { readonly nodes: readonly BuildGraphNodeState[] };
  readonly review: { readonly unresolved?: Readonly<Record<string, number>>; readonly lastReview?: unknown; readonly boundedLoop?: unknown };
  readonly agents: { readonly agents: readonly { readonly id: string; readonly guild: string; readonly status: string }[] };
  readonly skills: { readonly skills?: readonly unknown[] };
  readonly authorizations: { readonly authorizations?: readonly unknown[] };
  readonly testStatus: TestStatus | null;
}

const STATUSES = ["DONE", "READY", "RUNNING", "BLOCKED", "VALIDATING", "REVIEWING", "NOT_STARTED"] as const;

/** Parse the recorded (ACTUAL-run) vitest line "**N passed / M** across K files". null if absent. */
export function parseTestStatus(md: string): TestStatus | null {
  const m = /\*\*(\d+)\s+passed\s*\/\s*(\d+)\*\*\s+across\s+(\d+)\s+files/i.exec(md);
  if (!m) return null;
  return { passed: Number(m[1]), total: Number(m[2]), files: Number(m[3]) };
}

function countByStatus(nodes: readonly BuildGraphNodeState[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const n of nodes) c[n.status] = (c[n.status] ?? 0) + 1;
  return c;
}

export interface HomeViewModel {
  readonly product: string;
  readonly nodes: { readonly done: number; readonly ready: number; readonly blocked: number; readonly notStarted: number; readonly total: number };
  readonly tests: TestStatus | null;
  readonly activeSecurityValidation: string;
  readonly lastCheckpointCommit: string | null;
}
export function homeViewModel(s: RepoState): HomeViewModel {
  const by = countByStatus(s.buildGraph.nodes);
  return {
    product: s.master.product ?? "Universal AI Assurance Platform",
    nodes: { done: by.DONE ?? 0, ready: by.READY ?? 0, blocked: by.BLOCKED ?? 0, notStarted: by.NOT_STARTED ?? 0, total: s.buildGraph.nodes.length },
    tests: s.testStatus, // null => the view shows "unknown", never a fabricated pass
    activeSecurityValidation: s.master.activeSecurityValidation?.state ?? "LOCKED_BY_DESIGN",
    lastCheckpointCommit: s.master.lastCheckpoint?.commit ?? null,
  };
}

export interface BuildGraphViewModel {
  readonly byStatus: Readonly<Record<string, readonly BuildGraphNodeState[]>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly families: readonly string[];
}
export function buildGraphViewModel(s: RepoState): BuildGraphViewModel {
  const byStatus: Record<string, BuildGraphNodeState[]> = {};
  for (const st of STATUSES) byStatus[st] = [];
  for (const n of s.buildGraph.nodes) (byStatus[n.status] ??= []).push(n);
  return { byStatus, counts: countByStatus(s.buildGraph.nodes), families: [...new Set(s.buildGraph.nodes.map((n) => n.family))].sort() };
}

export interface AgentsViewModel {
  readonly total: number;
  readonly byGuild: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  /** Certified count from the authoritative state — NOT inferred/optimistic. */
  readonly certified: number;
}
export function agentsViewModel(s: RepoState): AgentsViewModel {
  const byGuild: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const a of s.agents.agents) {
    byGuild[a.guild] = (byGuild[a.guild] ?? 0) + 1;
    byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  }
  return { total: s.agents.agents.length, byGuild, byStatus, certified: s.master.canonicalAgents?.certified ?? 0 };
}

export interface ReviewsViewModel {
  readonly unresolved: Readonly<Record<string, number>>;
  readonly lastReview: unknown;
  readonly boundedLoop: unknown;
  /** True only when there are literally zero unresolved findings across severities. */
  readonly allResolved: boolean;
}
export function reviewsViewModel(s: RepoState): ReviewsViewModel {
  const unresolved = s.review.unresolved ?? {};
  const allResolved = Object.values(unresolved).every((n) => n === 0) && Object.keys(unresolved).length > 0;
  return { unresolved, lastReview: s.review.lastReview ?? null, boundedLoop: s.review.boundedLoop ?? null, allResolved };
}

export interface SecurityPostureViewModel {
  readonly activeValidation: string;
  readonly authorizationsPresent: boolean;
  readonly locked: boolean;
  /** Set when state is internally inconsistent (not locked yet no authorization exists) — surfaced, not hidden. */
  readonly inconsistency: string | null;
  readonly note: string;
}
export function securityPostureViewModel(s: RepoState): SecurityPostureViewModel {
  // FAIL-CLOSED: unknown/missing state reads as LOCKED_BY_DESIGN; "available" is shown only when the
  // state explicitly says so AND a real authorization exists.
  const activeValidation = s.master.activeSecurityValidation?.state ?? "LOCKED_BY_DESIGN";
  const authorizationsPresent = Array.isArray(s.authorizations.authorizations) && s.authorizations.authorizations.length > 0;
  const locked = activeValidation === "LOCKED_BY_DESIGN" || !authorizationsPresent;
  const inconsistency = activeValidation !== "LOCKED_BY_DESIGN" && !authorizationsPresent ? `state says "${activeValidation}" but no authorization record exists` : null;
  return {
    activeValidation,
    authorizationsPresent,
    locked,
    inconsistency,
    note: locked ? "Active security validation is locked; detection-only until an explicit signed scoped authorization exists." : "Active security validation is enabled by an authorization record in scope.",
  };
}

/** Load the real repository/runtime state for the view-models. Missing files degrade to safe, honest defaults. */
export function loadRepoState(startDir = dirname(fileURLToPath(import.meta.url))): RepoState {
  const root = findRepoRoot(startDir);
  const readJsonSafe = <T>(rel: string, fallback: T): T => {
    try {
      return existsSync(join(root, rel)) ? readRepoJson<T>(rel, startDir) : fallback;
    } catch {
      return fallback;
    }
  };
  const tsPath = join(root, ".ai", "TEST_STATUS.md");
  const testStatus = existsSync(tsPath) ? parseTestStatus(readFileSync(tsPath, "utf8")) : null;
  return {
    master: readJsonSafe(".ai/MASTER_STATE.json", {}),
    buildGraph: readJsonSafe(".ai/BUILD_GRAPH.json", { nodes: [] }),
    review: readJsonSafe(".ai/REVIEW_STATE.json", {}),
    agents: readJsonSafe("agents/registry/agents.json", { agents: [] }),
    skills: readJsonSafe("skills/registry/skills.json", { skills: [] }),
    authorizations: readJsonSafe(".ai/security/AUTHORIZATION_STATE.json", { authorizations: [] }),
    testStatus,
  };
}

/** Build every desktop view-model from the live repository state in one call. */
export function allViewModels(s: RepoState = loadRepoState()) {
  return {
    home: homeViewModel(s),
    buildGraph: buildGraphViewModel(s),
    agents: agentsViewModel(s),
    reviews: reviewsViewModel(s),
    securityPosture: securityPostureViewModel(s),
  };
}
