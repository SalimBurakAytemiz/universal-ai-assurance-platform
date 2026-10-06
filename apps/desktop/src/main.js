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

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
