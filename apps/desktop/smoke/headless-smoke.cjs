// Reproducible Electron headless smoke. Run from apps/desktop with:  npm run smoke
// (i.e. `electron smoke/headless-smoke.cjs`). Proves the real Electron runtime on this host without
// a desktop session: app becomes ready, a hidden BrowserWindow is created, a page loads, renderer JS
// is evaluated and read back, then a clean shutdown. Prints ONE SMOKE_RESULT / SMOKE_ERROR line and
// exits non-zero on failure, so it is CI/assertion-friendly. It fabricates nothing: every field is
// measured from the live run.
"use strict";
const { app, BrowserWindow } = require("electron");

const started = Date.now();
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, width: 480, height: 320, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    let crashed = false;
    win.webContents.on("render-process-gone", (_e, d) => {
      crashed = true;
      process.stdout.write("SMOKE_ERROR:render-gone " + JSON.stringify(d) + "\n");
      app.exit(2);
    });
    await win.loadURL("data:text/html,<!doctype html><title>UAAP</title><h1 id=t>ready</h1>");
    const text = await win.webContents.executeJavaScript("document.getElementById('t').textContent");
    const title = win.webContents.getTitle();
    if (!crashed) {
      const ok = text === "ready" && title === "UAAP";
      process.stdout.write("SMOKE_RESULT:" + JSON.stringify({ ok, ready: true, windowCreated: true, loaded: text === "ready", text, title, ms: Date.now() - started }) + "\n");
      win.destroy();
      // Exit DETERMINISTICALLY with the assertion's code. Do NOT defer via setTimeout after app.quit():
      // app.quit() completes shutdown and the process exits (code 0) before the timer fires, which
      // would report a failed assertion as a pass. app.exit(code) forces the exact code immediately.
      app.exit(ok ? 0 : 4);
    }
  } catch (e) {
    process.stdout.write("SMOKE_ERROR:" + (e && e.message ? e.message : String(e)) + "\n");
    app.exit(1);
  }
});

setTimeout(() => { process.stdout.write("SMOKE_ERROR:timeout-no-ready\n"); app.exit(3); }, 25000);
