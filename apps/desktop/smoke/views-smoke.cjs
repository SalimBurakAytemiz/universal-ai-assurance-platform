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

    const read = async (view) => {
      await js("show(" + JSON.stringify(view) + ");");
      return String(await js("document.getElementById('main').innerText"));
    };
    const homeTxt = await read("home");
    const agentsTxt = await read("agents");
    const secTxt = await read("security");
    const knowTxt = await read("knowledge");
    const learnTxt = await read("learning");

    const checks = {
      // Home reflects the real build-graph counts + effective (auth-gated) security + recorded tests.
      homeDoneTotal: homeTxt.includes(vm.home.nodes.done + "/" + vm.home.nodes.total + " done"),
      homeSecurity: homeTxt.includes(vm.home.activeSecurityValidation),
      // Agents shows the REAL registry total (the authoritative 72) and a guild breakdown.
      agentsRealTotal: vm.agents.total === 72 && agentsTxt.includes(String(vm.agents.total)),
      agentsCertified: agentsTxt.includes(String(vm.agents.certified)),
      // Security posture is FAIL-CLOSED: LOCKED with no authorization.
      securityLocked: vm.securityPosture.locked === true && secTxt.includes("LOCKED"),
      // Knowledge + Learning render real state (node counts / certification from .ai).
      knowledgeRendered: knowTxt.includes("Knowledge") && knowTxt.includes(String(expected.knowledge.nodes.length)),
      learningRendered: learnTxt.includes(expected.learning.certified + " / " + expected.learning.defined),
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
