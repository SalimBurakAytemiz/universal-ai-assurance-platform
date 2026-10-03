// Locked-down bridge. Exposes only a read-only state getter to the renderer.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uaap", {
  getState: () => ipcRenderer.invoke("uaap:getState"),
});
