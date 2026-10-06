"use strict";
// Renderer: honest control plane. The green "live" badge marks ONLY views that render real, present
// backend state (Home, System Health, Security, Agents, Knowledge, Learning, Authorization, Build
// Graph, Autopilot). Views that are wired but currently have no data to show (Release Center, Audit)
// render NOT AVAILABLE / empty and are NOT badged live — the badge must never claim green over a
// NOT AVAILABLE view. Everything whose backend is not built shows NOT AVAILABLE.

const MENU = [
  ["Overview", [["home", "Home", "live"], ["system-health", "System Health", "live"], ["audit", "Audit"]]],
  ["Project", [["organizations", "Organizations"], ["projects", "Projects"], ["architecture", "Architecture"], ["digital-twin", "Digital Twin"], ["domains", "Domains"], ["capabilities", "Capabilities"], ["journeys", "Critical Journeys"]]],
  ["Assurance", [["quality", "Quality"], ["security", "Security", "live"], ["data", "Data"], ["performance", "Performance"], ["reliability", "Reliability"], ["privacy", "Privacy"], ["accessibility", "Accessibility"]]],
  ["Agents & Knowledge", [["agents", "Agents", "live"], ["agent-teams", "Agent Teams"], ["evaluations", "Agent Evaluations"], ["knowledge", "Knowledge", "live"], ["learning", "Learning", "live"]]],
  ["Operations", [["runs", "Runs"], ["schedules", "Schedules"], ["automation", "Automation"], ["findings", "Findings"], ["risks", "Risks"], ["evidence", "Evidence"], ["reports", "Reports"]]],
  ["Governance", [["approvals", "Approvals"], ["policies", "Policies"], ["authorization", "Authorization", "live"], ["release", "Release Center"]]],
  ["Build", [["buildgraph", "Build Graph", "live"], ["autopilot", "Autopilot", "live"]]],
];

let STATE = null;

async function boot() {
  try {
    STATE = await window.uaap.getState();
  } catch (e) {
    STATE = { error: String(e) };
  }
  renderNav();
  show("home");
}

function renderNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  for (const [group, items] of MENU) {
    const h = document.createElement("h1");
    h.textContent = group;
    nav.appendChild(h);
    for (const [id, label, live] of items) {
      const a = document.createElement("a");
      a.dataset.id = id;
      a.onclick = () => show(id);
      const span = document.createElement("span");
      span.textContent = label;
      const badge = document.createElement("span");
      if (live) { badge.className = "badge ok"; badge.textContent = "live"; }
      else { badge.className = "badge na"; badge.textContent = "n/a"; }
      a.append(span, badge);
      nav.appendChild(a);
    }
  }
}

function setActive(id) {
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.id === id));
}

function el(html) { const d = document.createElement("div"); d.innerHTML = html; return d; }

function show(id) {
  setActive(id);
  const main = document.getElementById("main");
  main.innerHTML = "";
  const views = { home, "system-health": systemHealth, agents: agentsView, knowledge: knowledgeView, learning: learningView, security: securityView, authorization: authView, release: releaseView, buildgraph: buildGraphView, audit: auditView, autopilot: autopilotView };
  (views[id] || (() => notAvailable(id)))(main);
}

function notAvailable(id) {
  const main = document.getElementById("main");
  main.appendChild(el(`<p class="title">${id.replace(/-/g, " ")}</p>
    <p class="sub">This section's backend is not implemented yet.</p>
    <div class="na-note"><b>NOT AVAILABLE</b><br/>No working backend exists for this capability.
    This shell deliberately shows the real state instead of a fake dashboard. Track progress in
    the Build Graph view and in <code>.ai/BUILD_GRAPH.json</code>.</div>`));
}

function home(main) {
  const vm = STATE.viewModels;
  const g = STATE.buildGraph || { total: 0, byStatus: {} };
  // Prefer the reviewed view-model; fall back to raw counts only if the bundle is absent.
  const n = vm && vm.home ? vm.home.nodes : { done: g.byStatus.DONE || 0, total: g.total };
  const tests = vm && vm.home ? vm.home.tests : null;
  // Fail-closed: without the reviewed view-model we do NOT echo the raw master state word (which could
  // be an unbacked "ENABLED"); we show the locked-by-design posture.
  const sec = vm && vm.home ? vm.home.activeSecurityValidation : "LOCKED_BY_DESIGN";
  const locked = vm && vm.home ? vm.home.securityLocked : true;
  main.appendChild(el(`<p class="title">${STATE.product || "UAAP"}</p>
    <p class="sub">Local-first AI software assurance — one product, one repository, one desktop.</p>
    <div class="grid">
      <div class="card"><div class="k">Build graph</div><div class="v">${n.done}/${n.total} done</div></div>
      <div class="card"><div class="k">Tests</div><div class="v">${tests ? tests.passed + " / " + tests.total : "unknown"}</div></div>
      <div class="card"><div class="k">Active security validation</div><div class="v" style="color:${locked ? "var(--block)" : "var(--ok)"}">${sec}</div></div>
      <div class="card"><div class="k">Authorizations on file</div><div class="v">${STATE.authorizationsCount ?? 0}</div></div>
    </div>
    <p class="foot">Derived from the reviewed @uaap/desktop-viewmodels over real .ai/ state${vm ? "" : " (bundle not built — run npm run bundle)"}. Read at ${STATE.readAt || "?"}. ${STATE.error ? "ERROR: " + STATE.error : ""}</p>`));
}

// Color derives from the VALUE — green ONLY for a genuinely healthy/implemented status, muted for
// unknown, warn otherwise. Tokenized (not substring) matching so a NEGATED value can never show a
// false green: "NOT_IMPLEMENTED", "UNHEALTHY", "NOT OK" all contain a healthy word as a substring but
// must render warn. Any negation/degradation token forces warn (fail-closed); green requires a
// recognized healthy token AND no negative token.
const HEALTH_GOOD = new Set(["IMPLEMENTED", "HEALTHY", "TESTED", "OK", "DONE", "PASS", "PASSED", "ACTIVE", "VALIDATED"]);
const HEALTH_BAD = new Set([
  "NOT", "NON", "UN", "NO", "FAIL", "FAILED", "DEGRADED", "UNAVAILABLE", "UNHEALTHY", "BLOCKED",
  "MISSING", "ERROR", "STALE", "PENDING", "UNKNOWN", "UNVALIDATED", "SCAFFOLD", "SCAFFOLDED", "DOCUMENTED",
]);
function healthColor(v) {
  if (!v) return "var(--na)";
  const tokens = String(v).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (tokens.some((t) => HEALTH_BAD.has(t))) return "var(--warn)";
  return tokens.some((t) => HEALTH_GOOD.has(t)) ? "var(--ok)" : "var(--warn)";
}
function systemHealth(main) {
  const av = STATE.activeSecurityValidation || {};
  const cell = (v) => `<div class="v" style="color:${healthColor(v)}">${v || "unknown"}</div>`;
  main.appendChild(el(`<p class="title">System Health</p>
    <p class="sub">Core safety components (read from state; color derives from the real value).</p>
    <div class="grid">
      <div class="card"><div class="k">Trust Kernel</div>${cell(av.trustKernel)}</div>
      <div class="card"><div class="k">Policy Engine</div>${cell(av.policyEngine)}</div>
      <div class="card"><div class="k">Audit</div>${cell(av.audit)}</div>
    </div>`));
}

function agentsView(main) {
  const a = STATE.viewModels && STATE.viewModels.agents;
  if (!a) { notAvailable("agents"); return; }
  const guildRows = Object.entries(a.byGuild).sort().map(([g, n]) => `<tr><td>${g}</td><td>${n}</td></tr>`).join("");
  main.appendChild(el(`<p class="title">Agents</p>
    <p class="sub">Canonical agent role registry — real counts from the reviewed view-model (agents/registry/agents.json).</p>
    <div class="grid">
      <div class="card"><div class="k">Defined roles</div><div class="v">${a.total}</div></div>
      <div class="card"><div class="k">Certified</div><div class="v">${a.certified}</div></div>
      <div class="card"><div class="k">Guilds</div><div class="v">${Object.keys(a.byGuild).length}</div></div>
    </div>
    <table><thead><tr><th>guild</th><th>agents</th></tr></thead><tbody>${guildRows || '<tr><td colspan="2">none</td></tr>'}</tbody></table>
    <p class="foot">Certified comes from the authoritative state (0 until the certification layer promotes) — never inferred. Agent runtime/activation is a separate node, still NOT AVAILABLE.</p>`));
}

function knowledgeView(main) {
  const k = STATE.knowledge || { nodes: [], skillCount: 0 };
  const rows = k.nodes.map((n) => `<tr><td>${n.id}</td><td>${n.name}</td><td><span class="pill s-${n.status}">${n.status}</span></td></tr>`).join("");
  main.appendChild(el(`<p class="title">Knowledge</p>
    <p class="sub">Knowledge-domain build-graph nodes and skill registry — real state, no fabrication.</p>
    <div class="grid">
      <div class="card"><div class="k">Knowledge nodes</div><div class="v">${k.nodes.length}</div></div>
      <div class="card"><div class="k">Skills registered</div><div class="v">${k.skillCount}</div></div>
    </div>
    <table><thead><tr><th>id</th><th>name</th><th>status</th></tr></thead><tbody>${rows || '<tr><td colspan="3">none</td></tr>'}</tbody></table>`));
}

function learningView(main) {
  const l = STATE.learning || { nodes: [], certified: 0, defined: 0, reviewUnresolved: null };
  // Unresolved review findings: sum ALL severities from the reviewed view-model (guarded). When the
  // review state is ABSENT, show "unknown" (muted) — NEVER a green 0 (which would be fake all-clear).
  const rev = STATE.viewModels && STATE.viewModels.reviews;
  const haveReview = !!(rev && rev.unresolved && Object.keys(rev.unresolved).length > 0);
  const unresolvedTotal = haveReview ? Object.values(rev.unresolved).reduce((acc, n) => acc + (Number(n) || 0), 0) : null;
  const unresolvedText = haveReview ? String(unresolvedTotal) : "unknown";
  const unresolvedColor = !haveReview ? "var(--na)" : (unresolvedTotal ? "var(--warn)" : "var(--ok)");
  const rows = l.nodes.map((n) => `<tr><td>${n.id}</td><td>${n.name}</td><td><span class="pill s-${n.status}">${n.status}</span></td></tr>`).join("");
  main.appendChild(el(`<p class="title">Learning</p>
    <p class="sub">Evaluation, certification and sandbox — real state from .ai/ and the registries.</p>
    <div class="grid">
      <div class="card"><div class="k">Agents certified</div><div class="v">${l.certified} / ${l.defined}</div></div>
      <div class="card"><div class="k">Learning nodes</div><div class="v">${l.nodes.length}</div></div>
      <div class="card"><div class="k">Unresolved review findings</div><div class="v" style="color:${unresolvedColor}">${unresolvedText}</div></div>
    </div>
    <table><thead><tr><th>id</th><th>name</th><th>status</th></tr></thead><tbody>${rows || '<tr><td colspan="3">none</td></tr>'}</tbody></table>
    <p class="foot">Certified is read from the authoritative state (no self-certification). The sandbox runtime (@uaap/sandbox-learning) is DONE; agent activation/runtime remains a separate node.</p>`));
}

function securityView(main) {
  const sp = STATE.viewModels && STATE.viewModels.securityPosture;
  if (!sp) { notAvailable("security"); return; }
  main.appendChild(el(`<p class="title">Security</p>
    <p class="sub">Active-validation posture — FAIL-CLOSED (reviewed view-model).</p>
    <div class="grid">
      <div class="card"><div class="k">Active validation</div><div class="v" style="color:${sp.locked ? "var(--block)" : "var(--ok)"}">${sp.locked ? "LOCKED" : "ENABLED"}</div></div>
      <div class="card"><div class="k">State</div><div class="v">${sp.activeValidation}</div></div>
      <div class="card"><div class="k">Authorizations in force</div><div class="v">${sp.authorizationsPresent ? "yes" : "none"}</div></div>
    </div>
    ${sp.inconsistency ? `<div class="na-note"><b>INCONSISTENCY</b><br/>${sp.inconsistency}</div>` : ""}
    <p class="foot">${sp.note}</p>`));
}

function authView(main) {
  main.appendChild(el(`<p class="title">Authorization</p>
    <p class="sub">Active security validation requires explicit, scoped authorization.</p>
    <div class="card"><div class="k">Authorizations on file</div><div class="v">${STATE.authorizationsCount ?? 0}</div></div>
    <div class="na-note"><b>LOCKED BY DESIGN</b><br/>No external target is authorized. Active validation
    stays denied until a signed, scoped authorization record exists.</div>`));
}

function releaseView(main) {
  main.appendChild(el(`<p class="title">Release Center</p>
    <p class="sub">The release gate consumes real assurance results.</p>
    <div class="na-note"><b>NOT AVAILABLE</b><br/>No assurance runs have produced results yet, so no
    release decision can be made. The gate will not emit RELEASE_ALLOWED without real evidence.</div>`));
}

function auditView(main) {
  main.appendChild(el(`<p class="title">Audit</p>
    <p class="sub">Every decision is recorded in a tamper-evident ledger (hash chain).</p>
    <div class="na-note">No runs have executed in this build yet, so the live ledger is empty.
    The ledger implementation and its verification are tested in <code>packages/audit</code>.</div>`));
}

function autopilotView(main) {
  const a = STATE.autopilot || { present: false };
  if (!a.present) {
    main.appendChild(el(`<p class="title">Autopilot</p>
      <p class="sub">Session-independent automation service.</p>
      <div class="na-note"><b>NOT RUNNING</b><br/>No durable job store found at <code>.ai/autopilot/jobs.json</code>.
      Start it with <code>powershell -ExecutionPolicy Bypass -File .\\scripts\\start-full-auto.ps1</code>
      or <code>node services/autopilot/cli.mjs start</code>. It survives this UI closing and model unavailability.</div>`));
    return;
  }
  const rows = (a.jobs || []).map((j) =>
    `<tr><td>${j.id}</td><td>${j.name}</td><td>${j.kind}</td><td><span class="pill s-${j.state}">${j.state}</span></td>
     <td>${j.attempts || 0}</td><td>${j.nextRetryAt || "—"}</td></tr>`).join("");
  main.appendChild(el(`<p class="title">Autopilot</p>
    <p class="sub">Session-independent automation service (durable; survives restart + model unavailability).</p>
    <div class="grid">
      <div class="card"><div class="k">Control</div><div class="v">${a.control}</div></div>
      <div class="card"><div class="k">AI provider</div><div class="v" style="color:${a.providerAvailable ? "var(--ok)" : "var(--warn)"}">${a.providerAvailable ? "available" : "unavailable"}</div></div>
      <div class="card"><div class="k">Waiting on provider</div><div class="v">${(a.waitingProvider || []).length}</div></div>
      <div class="card"><div class="k">Running now</div><div class="v">${(a.running || []).length}</div></div>
    </div>
    <table><thead><tr><th>id</th><th>job</th><th>kind</th><th>state</th><th>attempts</th><th>next retry</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6">No jobs enqueued.</td></tr>'}</tbody></table>
    <p class="foot">AI tasks are never faked: when the provider is unavailable they are parked in
    WAITING_PROVIDER and resumed when it returns. State read from .ai/autopilot/.</p>`));
}

function buildGraphView(main) {
  const g = STATE.buildGraph || { nodes: [] };
  const rows = g.nodes
    .map((n) => `<tr><td>${n.id}</td><td>${n.name}</td><td>${n.family}</td>
      <td><span class="pill s-${n.status}">${n.status}</span></td></tr>`)
    .join("");
  main.appendChild(el(`<p class="title">Build Graph</p>
    <p class="sub">${g.total} nodes — dependency-aware continuous build.</p>
    <table><thead><tr><th>id</th><th>name</th><th>family</th><th>status</th></tr></thead>
    <tbody>${rows}</tbody></table>`));
}

boot();
