// Reproducible FULL-APP runtime validation for desktop-shell + the Agents/Knowledge/Learning/
// Security views. Run from apps/desktop with:  npm run views  (builds the view-model bundle first).
//
// It launches the REAL app surface headless (the production preload + renderer/index.html), registers
// the SAME IPC state handler main.js uses (from src/state.js), waits for the renderer to receive the
// real state, drives each view, and asserts the rendered DOM reflects the COMPUTED real view-model
// values — not hardcoded numbers. It fabricates nothing: expected values come from collectState().
// Exits 0 only if every view renders the real state; non-zero otherwise (CI/assertion-friendly).
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");
const { collectState } = require("../src/state");

ipcMain.handle("uaap:getState", () => collectState());
function out(obj) { process.stdout.write("VIEWS_RESULT:" + JSON.stringify(obj) + "\n"); }
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const expected = collectState();
  const vm = expected.viewModels;
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { preload: join(__dirname, "..", "src", "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    if (!vm) { out({ ok: false, stage: "bundle", reason: "view-model bundle not built (run npm run bundle)" }); return app.exit(5); }
    await win.loadFile(join(__dirname, "..", "renderer", "index.html"));
    const js = (code) => win.webContents.executeJavaScript(code);

    // Wait for boot() to receive the real state and render the home view.
    let ready = false;
    for (let i = 0; i < 100; i++) {
      const r = await js("(function(){var m=document.querySelector('#main .title');return m?1:0;})()").catch(() => 0);
      if (r) { ready = true; break; }
      await new Promise((res) => setTimeout(res, 100));
    }
    if (!ready) { out({ ok: false, stage: "boot", reason: "renderer did not render within timeout" }); win.destroy(); return app.exit(2); }

    // Use textContent (layout-independent) — innerText is empty on an offscreen show:false window.
    const read = async (view) => {
      await js("show(" + JSON.stringify(view) + ");");
      return String(await js("document.getElementById('main').textContent"));
    };
    // Read a specific card's value by its label (scoped DOM), so a check can't pass on stray/footer copy.
    const cardVal = async (label) => js(
      "(function(){var cs=[].slice.call(document.querySelectorAll('#main .card'));" +
      "for(var i=0;i<cs.length;i++){var k=cs[i].querySelector('.k');" +
      "if(k&&k.textContent.trim()===" + JSON.stringify(label) + "){var v=cs[i].querySelector('.v');return v?v.textContent.trim():null;}}return null;})()"
    ).then((x) => (x === null ? null : String(x)));

    await read("home");
    const homeDoneCard = await cardVal("Build graph");
    const homeSecCard = await cardVal("Active security validation");
    await read("agents");
    const agentsTotalCard = await cardVal("Defined roles");
    const agentsCertCard = await cardVal("Certified");
    const secTxt = await read("security");
    const secStateCard = await cardVal("State");
    const knowTxt = await read("knowledge");
    const knowNodesCard = await cardVal("Knowledge nodes");
    await read("learning");
    const learnCertCard = await cardVal("Agents certified");

    // Ground-truth anchors: a known knowledge node id must actually render in the table.
    const knownKnowledgeId = (expected.knowledge.nodes.find((n) => n.id === "knowledge-store") || expected.knowledge.nodes[0] || {}).id || "";

    const checks = {
      // Home reflects the real build-graph counts (card-scoped) + effective auth-gated security.
      homeDoneTotal: homeDoneCard === vm.home.nodes.done + "/" + vm.home.nodes.total + " done",
      homeSecurity: homeSecCard === vm.home.activeSecurityValidation,
      // Agents shows the REAL registry total (the authoritative 72) and certified, read from the cards.
      agentsRealTotal: vm.agents.total === 72 && agentsTotalCard === String(vm.agents.total),
      agentsCertified: agentsCertCard === String(vm.agents.certified),
      // Security posture is FAIL-CLOSED: LOCKED with no authorization; the State card shows the real value.
      securityLocked: vm.securityPosture.locked === true && secTxt.includes("LOCKED") && secStateCard === vm.securityPosture.activeValidation,
      // Knowledge: card-scoped count matches real state AND a known node id actually renders in the table.
      knowledgeRendered: expected.knowledge.nodes.length > 0 && knowNodesCard === String(expected.knowledge.nodes.length) && !!knownKnowledgeId && knowTxt.includes(knownKnowledgeId),
      // Learning: certification is card-scoped against the authoritative state.
      learningRendered: learnCertCard === expected.learning.certified + " / " + expected.learning.defined,
    };
    const ok = Object.values(checks).every(Boolean);
    out({ ok, checks, agentsTotal: vm.agents.total, securityLocked: vm.securityPosture.locked, homeDone: vm.home.nodes.done, homeTotal: vm.home.nodes.total });
    win.destroy();
    app.exit(ok ? 0 : 3);
  } catch (e) {
    out({ ok: false, error: (e && e.message) ? e.message : String(e) });
    app.exit(1);
  }
});

setTimeout(() => { out({ ok: false, error: "timeout-no-result" }); app.exit(4); }, 40000);
