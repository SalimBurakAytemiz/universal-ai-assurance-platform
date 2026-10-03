// Durable, crash-safe job store for the autopilot.
//
// Durability:
//  - writes are atomic (temp file, fsync, rename) with a best-effort directory fsync;
//  - the previous good document is kept as `<file>.bak` before each replace;
//  - a corrupt/torn store is NEVER silently treated as empty and NEVER overwritten: load() tries
//    the backup, and if neither parses it renames the bad file to `<file>.corrupt.<ts>` and THROWS
//    so the service fails loudly instead of forgetting every completed job.
//
// Control (pause/resume/stop) lives in a SEPARATE tiny file so a control command never rewrites
// the jobs document (avoids a lost-update race with the running loop).
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const VERSION = "1";

function atomicWrite(file, data) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Math.floor(performance.now())}.tmp`);
  const fd = openSync(tmp, "w");
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  try { if (existsSync(file)) copyFileSync(file, `${file}.bak`); } catch { /* best effort backup */ }
  renameSync(tmp, file); // atomic on same filesystem
  try { const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* dir fsync unsupported on some FS */ }
}

export class JobStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this.controlPath = join(dirname(filePath), "control.json");
    this.jobs = new Map();
    this.meta = {};
    this.load();
  }

  load() {
    this.jobs = new Map();
    this.meta = {};
    if (!existsSync(this.filePath)) return; // fresh start
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      if (existsSync(`${this.filePath}.bak`)) {
        try { doc = JSON.parse(readFileSync(`${this.filePath}.bak`, "utf8")); } catch { doc = null; }
      }
      if (!doc) {
        const corrupt = `${this.filePath}.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}`;
        try { renameSync(this.filePath, corrupt); } catch { /* ignore */ }
        throw new Error(`Autopilot job store is corrupt and no valid backup exists; refusing to start (moved to ${corrupt}).`);
      }
    }
    for (const j of doc.jobs ?? []) if (j && typeof j.id === "string") this.jobs.set(j.id, j);
    this.meta = doc.meta ?? {};
  }

  save() {
    atomicWrite(this.filePath, JSON.stringify({ version: VERSION, jobs: [...this.jobs.values()], meta: this.meta }, null, 2) + "\n");
  }

  upsert(job) { this.jobs.set(job.id, job); this.save(); return job; }
  get(id) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  setMeta(key, value) { this.meta[key] = value; this.save(); }

  // --- control (separate file; never rewrites the jobs document) ---
  readControl() {
    try { if (existsSync(this.controlPath)) return JSON.parse(readFileSync(this.controlPath, "utf8")).control ?? "run"; } catch { /* fall through */ }
    return "run";
  }
  writeControl(v) { atomicWrite(this.controlPath, JSON.stringify({ control: v }) + "\n"); }

  removeBackup() { try { rmSync(`${this.filePath}.bak`, { force: true }); } catch { /* ignore */ } }
}
