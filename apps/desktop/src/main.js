// Electron main process. Reads REAL .ai state (via src/state.js, which derives the renderer's
// view-models from the REVIEWED @uaap/desktop-viewmodels bundle) and exposes it to the renderer via
// a locked-down preload bridge. It never fabricates status: a capability with no backend is reported
// as NOT_AVAILABLE, never as a fake green.
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");
const { collectState } = require("./state");

ipcMain.handle("uaap:getState", () => collectState());

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "Universal AI Assurance Platform",
    backgroundColor: "#0b0e14",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(join(__dirname, "..", "renderer", "index.html"));
}

// Startup smoke mode: `UAAP_SMOKE=1` launches the app headless, asserts every view renders the real
// state (via src/views-check.js), prints VIEWS_RESULT, and exits non-zero on any failure. This lets
// a PACKAGED build self-validate (point it at the repo with UAAP_REPO_ROOT) — real startup proof.
async function runStartupSmoke() {
  const { assertViews } = require("./views-check");
  const win = new BrowserWindow({
    show: false, width: 1280, height: 860,
    webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await win.loadFile(join(__dirname, "..", "renderer", "index.html"));
    const r = await assertViews(win, collectState());
    process.stdout.write("VIEWS_RESULT:" + JSON.stringify(r) + "\n");
    app.exit(r.ok ? 0 : 3);
  } catch (e) {
    process.stdout.write("VIEWS_ERROR:" + ((e && e.message) ? e.message : String(e)) + "\n");
    app.exit(1);
  }
}

app.whenReady().then(() => {
  if (process.env.UAAP_SMOKE === "1") {
    setTimeout(() => { process.stdout.write("VIEWS_ERROR:timeout\n"); app.exit(4); }, 40000);
    return runStartupSmoke();
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
