// Reproducible FULL-APP runtime validation for desktop-shell + the Agents/Knowledge/Learning/
// Security views. Run from apps/desktop with:  npm run views  (builds the view-model bundle first).
// Launches the REAL app surface headless (production preload + renderer/index.html), registers the
// SAME IPC state handler main.js uses, and asserts (via src/views-check.js) that every view renders
// the COMPUTED real view-model values. Exits 0 only if every view renders the real state.
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");
const { collectState } = require("../src/state");
const { assertViews } = require("../src/views-check");

ipcMain.handle("uaap:getState", () => collectState());
function out(obj) { process.stdout.write("VIEWS_RESULT:" + JSON.stringify(obj) + "\n"); }
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { preload: join(__dirname, "..", "src", "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadFile(join(__dirname, "..", "renderer", "index.html"));
    const r = await assertViews(win, collectState());
    out(r);
    win.destroy();
    app.exit(r.ok ? 0 : 3);
  } catch (e) {
    out({ ok: false, error: (e && e.message) ? e.message : String(e) });
    app.exit(1);
  }
});

setTimeout(() => { out({ ok: false, error: "timeout-no-result" }); app.exit(4); }, 40000);
