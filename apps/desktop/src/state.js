// Desktop state layer. Reads REAL .ai/ state and derives the renderer's view-models from the
// REVIEWED @uaap/desktop-viewmodels bundle — never fabricates status (a capability with no backend
// reads NOT_AVAILABLE, never fake green). Shared by main.js (the app) and the views smoke test so
// both expose identical, real state.
"use strict";
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

// Repo root is three levels up from apps/desktop/src — OVERRIDABLE via UAAP_REPO_ROOT so a PACKAGED
// build (where __dirname is inside the app bundle, not the repo) can be pointed at the real repo for
// a startup smoke. In normal dev/app use the env is unset and the computed path is used.
const REPO_ROOT = (typeof process.env.UAAP_REPO_ROOT === "string" && process.env.UAAP_REPO_ROOT.trim())
  ? process.env.UAAP_REPO_ROOT
  : join(__dirname, "..", "..", "..");

// The REVIEWED view-model logic (bundled from @uaap/desktop-viewmodels). The desktop never
// re-implements these derivations — it consumes the same adversarially-reviewed, fail-closed layer
// the tests cover. If the bundle is missing (not built), VM is null and the renderer shows an honest
// build note rather than fabricating values.
let VM = null;
try {
  VM = require(join(__dirname, "..", "vendor", "desktop-viewmodels.cjs"));
} catch {
  VM = null;
}

/** Derived view-models from REAL repo state via the bundled package; null if the bundle is absent. */
function computeViewModels() {
  if (!VM || typeof VM.allViewModels !== "function" || typeof VM.loadRepoState !== "function") return null;
  try {
    // Load from REPO_ROOT (honors UAAP_REPO_ROOT) so a packaged build resolves the real repo state.
    return VM.allViewModels(VM.loadRepoState(REPO_ROOT));
  } catch {
    return null;
  }
}

/** Real Knowledge-domain summary: knowledge-family build-graph nodes + registry counts (no fabrication). */
function knowledgeSummary(nodes, skills) {
  const fam = (nodes || []).filter((n) => n && typeof n.family === "string" && /knowledge/i.test(n.family));
  return {
    nodes: fam.map((n) => ({ id: n.id, name: n.name, status: n.status })),
    skillCount: skills && Array.isArray(skills.skills) ? skills.skills.length : 0,
  };
}

/** Real Learning-domain summary: evaluation/sandbox nodes + certification state (no fabrication). */
function learningSummary(nodes, master, review) {
  const fam = (nodes || []).filter((n) => n && (/(agent-evaluation|sandbox-learning|knowledge-lifecycle)/.test(n.id) || /learning|evaluation/i.test(n.family || "")));
  const canon = (master && master.canonicalAgents) || {};
  return {
    nodes: fam.map((n) => ({ id: n.id, name: n.name, status: n.status })),
    certified: typeof canon.certified === "number" ? canon.certified : 0,
    defined: typeof canon.defined === "number" ? canon.defined : 0,
    reviewUnresolved: (review && review.unresolved) || null,
  };
}

function readJsonSafe(rel) {
  try {
    const p = join(REPO_ROOT, rel);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function collectState() {
  const master = readJsonSafe(".ai/MASTER_STATE.json");
  const graph = readJsonSafe(".ai/BUILD_GRAPH.json");
  const github = readJsonSafe(".ai/GITHUB_STATE.json");
  const auth = readJsonSafe(".ai/security/AUTHORIZATION_STATE.json");
  const nodes = (graph && graph.nodes) || [];
  const byStatus = nodes.reduce((acc, n) => ((acc[n.status] = (acc[n.status] || 0) + 1), acc), {});

  // Autopilot: read the durable job store + provider control (same files the service uses).
  const apDoc = readJsonSafe(".ai/autopilot/jobs.json");
  const provider = readJsonSafe(".ai/autopilot/provider.json");
  const apControl = readJsonSafe(".ai/autopilot/control.json");
  const apJobs = (apDoc && apDoc.jobs) || [];
  const apByState = apJobs.reduce((acc, j) => ((acc[j.state] = (acc[j.state] || 0) + 1), acc), {});
  const autopilot = {
    present: !!apDoc,
    control: (apControl && apControl.control) || "run",
    providerAvailable: provider ? provider.available === true : false,
    byState: apByState,
    running: apJobs.filter((j) => j.state === "RUNNING").map((j) => j.name),
    waitingProvider: apJobs.filter((j) => j.state === "WAITING_PROVIDER").map((j) => j.name),
    retryScheduled: apJobs.filter((j) => j.state === "RETRY_SCHEDULED").map((j) => ({ name: j.name, nextRetryAt: j.nextRetryAt })),
    jobs: apJobs.map((j) => ({ id: j.id, name: j.name, kind: j.kind, state: j.state, attempts: j.attempts, nextRetryAt: j.nextRetryAt || null })),
  };

  const review = readJsonSafe(".ai/REVIEW_STATE.json");
  const skills = readJsonSafe("skills/registry/skills.json");
  return {
    product: (master && master.product) || "Universal AI Assurance Platform",
    repository: master && master.repository,
    activeSecurityValidation: master && master.activeSecurityValidation,
    authorizationsCount: auth ? (auth.authorizations || []).length : 0,
    github,
    buildGraph: { total: nodes.length, byStatus, nodes },
    autopilot,
    // The reviewed, fail-closed view-models (home/buildGraph/agents/reviews/securityPosture) + the
    // real Knowledge/Learning domain summaries. viewModels is null only if the bundle is not built.
    viewModels: computeViewModels(),
    knowledge: knowledgeSummary(nodes, skills),
    learning: learningSummary(nodes, master, review),
    readAt: new Date().toISOString(),
  };
}

module.exports = { collectState, REPO_ROOT };
