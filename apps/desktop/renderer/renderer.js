"use strict";
// Renderer: honest control plane. Only Home, Build Graph, Agents(count), System Health and
// Release Center read real state. Everything whose backend is not built shows NOT AVAILABLE.

const MENU = [
  ["Overview", [["home", "Home", "live"], ["system-health", "System Health", "live"], ["audit", "Audit", "live"]]],
  ["Project", [["organizations", "Organizations"], ["projects", "Projects"], ["architecture", "Architecture"], ["digital-twin", "Digital Twin"], ["domains", "Domains"], ["capabilities", "Capabilities"], ["journeys", "Critical Journeys"]]],
  ["Assurance", [["quality", "Quality"], ["security", "Security"], ["data", "Data"], ["performance", "Performance"], ["reliability", "Reliability"], ["privacy", "Privacy"], ["accessibility", "Accessibility"]]],
  ["Agents & Knowledge", [["agents", "Agents", "live"], ["agent-teams", "Agent Teams"], ["evaluations", "Agent Evaluations"], ["knowledge", "Knowledge"], ["learning", "Learning"]]],
  ["Operations", [["runs", "Runs"], ["schedules", "Schedules"], ["automation", "Automation"], ["findings", "Findings"], ["risks", "Risks"], ["evidence", "Evidence"], ["reports", "Reports"]]],
  ["Governance", [["approvals", "Approvals"], ["policies", "Policies"], ["authorization", "Authorization", "live"], ["release", "Release Center", "live"]]],
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
  const views = { home, "system-health": systemHealth, agents: agentsView, authorization: authView, release: releaseView, buildgraph: buildGraphView, audit: auditView, autopilot: autopilotView };
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
  const g = STATE.buildGraph || { total: 0, byStatus: {} };
  const av = STATE.activeSecurityValidation || {};
  main.appendChild(el(`<p class="title">${STATE.product || "UAAP"}</p>
    <p class="sub">Local-first AI software assurance — one product, one repository, one desktop.</p>
    <div class="grid">
      <div class="card"><div class="k">Build graph</div><div class="v">${g.byStatus.DONE || 0}/${g.total} done</div></div>
      <div class="card"><div class="k">Active security validation</div><div class="v" style="color:var(--block)">${(av.state || "UNKNOWN")}</div></div>
      <div class="card"><div class="k">Authorizations on file</div><div class="v">${STATE.authorizationsCount ?? 0}</div></div>
      <div class="card"><div class="k">GitHub</div><div class="v">${(STATE.github && STATE.github.created) ? "connected" : "pending"}</div></div>
    </div>
    <p class="foot">State read at ${STATE.readAt || "?"} from .ai/. ${STATE.error ? "ERROR: " + STATE.error : ""}</p>`));
}

function systemHealth(main) {
  const av = STATE.activeSecurityValidation || {};
  main.appendChild(el(`<p class="title">System Health</p>
    <p class="sub">Core safety components (read from state).</p>
    <div class="grid">
      <div class="card"><div class="k">Trust Kernel</div><div class="v" style="color:var(--ok)">${av.trustKernel || "?"}</div></div>
      <div class="card"><div class="k">Policy Engine</div><div class="v" style="color:var(--ok)">${av.policyEngine || "?"}</div></div>
      <div class="card"><div class="k">Audit</div><div class="v" style="color:var(--ok)">${av.audit || "?"}</div></div>
    </div>`));
}

function agentsView(main) {
  main.appendChild(el(`<p class="title">Agents</p>
    <p class="sub">72 canonical role definitions (9 guilds × 8). Runtime/evaluation not yet implemented.</p>
    <div class="grid">
      <div class="card"><div class="k">Defined roles</div><div class="v">72 / 72</div></div>
      <div class="card"><div class="k">Certified</div><div class="v">0</div></div>
      <div class="card"><div class="k">Running</div><div class="v na" style="color:var(--na)">N/A</div></div>
    </div>
    <div class="na-note">Agent runtime, activation planner, and evaluation are NOT AVAILABLE yet.
    Definitions live in <code>agents/registry/agents.json</code>.</div>`));
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
