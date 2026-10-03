// Electron main process. Reads REAL .ai state from the repository and exposes it to the
// renderer via a locked-down preload bridge. It never fabricates status: a capability with
// no backend is reported as NOT_AVAILABLE, never as a fake green.
"use strict";
const { app, BrowserWindow, ipcMain } = require("electron");
const { readFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");

// Repo root is three levels up from apps/desktop/src.
const REPO_ROOT = join(__dirname, "..", "..", "..");

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
    // control now lives in its own file (decoupled from the jobs document)
    control: (apControl && apControl.control) || "run",
    providerAvailable: provider ? provider.available === true : false,
    byState: apByState,
    running: apJobs.filter((j) => j.state === "RUNNING").map((j) => j.name),
    waitingProvider: apJobs.filter((j) => j.state === "WAITING_PROVIDER").map((j) => j.name),
    retryScheduled: apJobs.filter((j) => j.state === "RETRY_SCHEDULED").map((j) => ({ name: j.name, nextRetryAt: j.nextRetryAt })),
    jobs: apJobs.map((j) => ({ id: j.id, name: j.name, kind: j.kind, state: j.state, attempts: j.attempts, nextRetryAt: j.nextRetryAt || null })),
  };

  return {
    product: (master && master.product) || "Universal AI Assurance Platform",
    repository: master && master.repository,
    activeSecurityValidation: master && master.activeSecurityValidation,
    authorizationsCount: auth ? (auth.authorizations || []).length : 0,
    github,
    buildGraph: { total: nodes.length, byStatus, nodes },
    autopilot,
    readAt: new Date().toISOString(),
  };
}

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
