// @uaap/desktop-viewmodels — the data layer behind the desktop views. It derives typed view-models
// from the REAL repository/runtime state (.ai/*, the agent/skill registries, the recorded test
// status) and NOTHING ELSE: there is no hardcoded "green", no fabricated count, no optimistic
// default. Every value a view shows traces to a state field; where state is absent the view-model
// says "unknown", never "ok". Security posture is FAIL-CLOSED by an ALLOW-LIST: active validation
// reads as LOCKED unless the real state EXPLICITLY says it is ENABLED *and* a structurally-genuine,
// scoped authorization record actually exists. Any unknown/ambiguous/malformed state or placeholder
// authorization reads as LOCKED, and the home summary surfaces the same auth-gated posture (never a
// raw "ENABLED" string that no authorization backs).
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

const TEST_LINE_RE = /\*\*(\d+)\s+passed\s*\/\s*(\d+)\*\*\s+across\s+(\d+)\s+files/gi;

/** Restrict parsing to the authoritative "## Last local run" section so a stale, earlier, or
 * aspirational "N passed / M across K files" line elsewhere in the document can never be mistaken
 * for the most recent recorded run. When no such section exists (e.g. a bare line), the whole input
 * is the scope. */
function lastLocalRunScope(md: string): string {
  const header = /^##\s+Last local run\b.*$/im.exec(md);
  if (!header) return md;
  const start = header.index + header[0].length;
  const rest = md.slice(start);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Parse the recorded (ACTUAL-run) vitest line "**N passed / M** across K files" from the
 * authoritative latest-run section. null if absent — never a fabricated or stale count. */
export function parseTestStatus(md: string): TestStatus | null {
  if (typeof md !== "string") return null;
  const scope = lastLocalRunScope(md);
  // Take the LAST match within the authoritative scope (the most recently appended line wins).
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  TEST_LINE_RE.lastIndex = 0;
  while ((m = TEST_LINE_RE.exec(scope)) !== null) last = m;
  if (!last) return null;
  return { passed: Number(last[1]), total: Number(last[2]), files: Number(last[3]) };
}

/** Build-graph nodes, defensively coerced to an array — a malformed/shapeless buildGraph degrades
 * to zero nodes (honest "nothing known"), never a crash. */
function nodesOf(s: RepoState): readonly BuildGraphNodeState[] {
  return Array.isArray(s.buildGraph?.nodes) ? s.buildGraph.nodes : [];
}

function countByStatus(nodes: readonly BuildGraphNodeState[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const n of nodes) {
    const status = n && typeof n.status === "string" ? n.status : "NOT_STARTED";
    c[status] = (c[status] ?? 0) + 1;
  }
  return c;
}

export interface HomeViewModel {
  readonly product: string;
  readonly nodes: { readonly done: number; readonly ready: number; readonly blocked: number; readonly notStarted: number; readonly total: number };
  readonly tests: TestStatus | null;
  /** The EFFECTIVE, auth-gated active-validation posture — "LOCKED_BY_DESIGN" unless a genuine
   * authorization actually unlocks it (never a raw, unbacked "ENABLED" string). */
  readonly activeSecurityValidation: string;
  readonly securityLocked: boolean;
  readonly securityInconsistency: string | null;
  readonly lastCheckpointCommit: string | null;
}
export function homeViewModel(s: RepoState): HomeViewModel {
  const nodes = nodesOf(s);
  const by = countByStatus(nodes);
  const posture = securityPostureViewModel(s);
  return {
    product: s.master.product ?? "Universal AI Assurance Platform",
    nodes: { done: by.DONE ?? 0, ready: by.READY ?? 0, blocked: by.BLOCKED ?? 0, notStarted: by.NOT_STARTED ?? 0, total: nodes.length },
    tests: s.testStatus, // null => the view shows "unknown", never a fabricated pass
    // AUTH-GATED: the home badge shows the raw state ONLY when the posture is genuinely unlocked;
    // otherwise it reads LOCKED_BY_DESIGN, so an unbacked "ENABLED" can never render as fake green.
    activeSecurityValidation: posture.locked ? "LOCKED_BY_DESIGN" : posture.activeValidation,
    securityLocked: posture.locked,
    securityInconsistency: posture.inconsistency,
    lastCheckpointCommit: s.master.lastCheckpoint?.commit ?? null,
  };
}

export interface BuildGraphViewModel {
  readonly byStatus: Readonly<Record<string, readonly BuildGraphNodeState[]>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly families: readonly string[];
}
export function buildGraphViewModel(s: RepoState): BuildGraphViewModel {
  const nodes = nodesOf(s);
  const byStatus: Record<string, BuildGraphNodeState[]> = {};
  for (const st of STATUSES) byStatus[st] = [];
  for (const n of nodes) {
    const status = n && typeof n.status === "string" ? n.status : "NOT_STARTED";
    (byStatus[status] ??= []).push(n);
  }
  return { byStatus, counts: countByStatus(nodes), families: [...new Set(nodes.map((n) => n.family).filter((f): f is string => typeof f === "string"))].sort() };
}

export interface AgentsViewModel {
  readonly total: number;
  readonly byGuild: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  /** Certified count from the authoritative state — NOT inferred/optimistic. */
  readonly certified: number;
}
export function agentsViewModel(s: RepoState): AgentsViewModel {
  const agents = Array.isArray(s.agents?.agents) ? s.agents.agents : [];
  const byGuild: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const a of agents) {
    const guild = a && typeof a.guild === "string" ? a.guild : "UNKNOWN";
    const status = a && typeof a.status === "string" ? a.status : "UNKNOWN";
    byGuild[guild] = (byGuild[guild] ?? 0) + 1;
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  return { total: agents.length, byGuild, byStatus, certified: s.master.canonicalAgents?.certified ?? 0 };
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
/** The ONLY active-validation state strings that may unlock (positive allow-list). Everything else —
 * LOCKED_BY_DESIGN, unknown, empty, a typo, wrong case — reads as LOCKED. */
const ACTIVE_VALIDATION_ENABLED_STATES: ReadonlySet<string> = new Set(["ENABLED"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/** A structurally-genuine, scoped authorization record — the "authorization record + explicit
 * scope" the hard rules require: an id, a bound targetId, and at least one explicitly-covered
 * identifier (matching @uaap/core AuthorizationRecord). This is a fail-closed STRUCTURAL check, not
 * the kernel's full window/mode evaluation, so a placeholder/malformed entry ([{}], [null], [0],
 * [""], an id-only stub) can never masquerade as a real authorization. */
function isGenuineAuthorization(a: unknown): boolean {
  if (typeof a !== "object" || a === null) return false;
  const r = a as Record<string, unknown>;
  return (
    isNonEmptyString(r.id) &&
    isNonEmptyString(r.targetId) &&
    Array.isArray(r.allowedIdentifiers) &&
    r.allowedIdentifiers.some(isNonEmptyString)
  );
}

export function securityPostureViewModel(s: RepoState): SecurityPostureViewModel {
  // FAIL-CLOSED / ALLOW-LIST: unknown or missing state reads as LOCKED; active validation is shown
  // as unlocked ONLY when the state is an explicit ENABLED signal AND a genuine scoped authorization
  // record actually exists. Any over-claim is surfaced as an inconsistency, never hidden.
  const activeValidation = s.master.activeSecurityValidation?.state ?? "LOCKED_BY_DESIGN";
  const authList = Array.isArray(s.authorizations?.authorizations) ? s.authorizations.authorizations : [];
  const genuineAuthorizations = authList.filter(isGenuineAuthorization).length;
  const authorizationsPresent = genuineAuthorizations > 0;
  const stateClaimsEnabled = ACTIVE_VALIDATION_ENABLED_STATES.has(activeValidation);
  const locked = !(stateClaimsEnabled && authorizationsPresent);

  let inconsistency: string | null = null;
  if (stateClaimsEnabled && !authorizationsPresent) {
    inconsistency = `state says "${activeValidation}" but no genuine scoped authorization record exists`;
  } else if (!stateClaimsEnabled && activeValidation !== "LOCKED_BY_DESIGN") {
    // A value that is neither the locked sentinel nor a recognized enabled signal is ambiguous →
    // DENY (locked) and say so, rather than silently treating it as enabled OR as locked-by-design.
    inconsistency = `unrecognized active-validation state "${activeValidation}" — treated as LOCKED (fail-closed)`;
  }
  return {
    activeValidation,
    authorizationsPresent,
    locked,
    inconsistency,
    note: locked ? "Active security validation is locked; detection-only until an explicit signed scoped authorization exists." : "Active security validation is enabled by an authorization record in scope.",
  };
}

/** The all-defaults state: everything "unknown"/empty, nothing green. Returned whenever the real
 * state cannot be located or read, so the views degrade honestly instead of crashing. */
function defaultRepoState(): RepoState {
  return { master: {}, buildGraph: { nodes: [] }, review: {}, agents: { agents: [] }, skills: { skills: [] }, authorizations: { authorizations: [] }, testStatus: null };
}

/** Load the real repository/runtime state for the view-models. EVERY access degrades to safe, honest
 * defaults: an unlocatable repo root (e.g. a packaged/relocated build) or an unreadable file
 * (EISDIR/EACCES/TOCTOU) yields "unknown", never a thrown exception that would crash the view. */
export function loadRepoState(startDir = dirname(fileURLToPath(import.meta.url))): RepoState {
  let root: string;
  try {
    root = findRepoRoot(startDir);
  } catch {
    return defaultRepoState(); // repo root not locatable → all-defaults (honest "unknown")
  }
  const readJsonSafe = <T>(rel: string, fallback: T): T => {
    try {
      return existsSync(join(root, rel)) ? readRepoJson<T>(rel, startDir) : fallback;
    } catch {
      return fallback;
    }
  };
  let testStatus: TestStatus | null = null;
  try {
    const tsPath = join(root, ".ai", "TEST_STATUS.md");
    testStatus = existsSync(tsPath) ? parseTestStatus(readFileSync(tsPath, "utf8")) : null;
  } catch {
    testStatus = null; // directory/permission/race on the read → unknown, never a crash
  }
  const buildGraphRaw = readJsonSafe<{ nodes?: unknown }>(".ai/BUILD_GRAPH.json", { nodes: [] });
  const agentsRaw = readJsonSafe<{ agents?: unknown }>("agents/registry/agents.json", { agents: [] });
  const authRaw = readJsonSafe<{ authorizations?: unknown }>(".ai/security/AUTHORIZATION_STATE.json", { authorizations: [] });
  return {
    master: readJsonSafe(".ai/MASTER_STATE.json", {}),
    buildGraph: { nodes: Array.isArray(buildGraphRaw?.nodes) ? (buildGraphRaw.nodes as readonly BuildGraphNodeState[]) : [] },
    review: readJsonSafe(".ai/REVIEW_STATE.json", {}),
    agents: { agents: Array.isArray(agentsRaw?.agents) ? (agentsRaw.agents as RepoState["agents"]["agents"]) : [] },
    skills: readJsonSafe("skills/registry/skills.json", { skills: [] }),
    authorizations: { authorizations: Array.isArray(authRaw?.authorizations) ? (authRaw.authorizations as readonly unknown[]) : [] },
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
