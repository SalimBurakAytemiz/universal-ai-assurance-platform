// Durable, crash-safe, cross-process-safe job store for the autopilot.
//
// Durability:
//  - writes are atomic (temp file, fsync, rename) with a best-effort directory fsync;
//  - the previous good document is kept as `<file>.bak` before each replace, but ONLY when the
//    current main file is itself parseable (never clobber a good backup with a corrupt main);
//  - a corrupt/torn store is NEVER silently treated as empty and NEVER overwritten: load() tries
//    the backup; if the backup is good it REPAIRS the main from it; if neither parses it copies the
//    bad file to `<file>.corrupt`, leaves the corrupt main in place (so the refusal is STICKY across
//    restarts) and THROWS.
//
// Cross-process safety:
//  - an advisory lock file (`<file>.lock`) serializes read-modify-write across processes, so a
//    running `start` loop and a separate `recover`/`addJob` process cannot double-execute jobs or
//    lose updates. Stale locks (dead pid or aged out) are reclaimed atomically via unlink + O_EXCL.
//
// Control (pause/resume/stop) lives in a SEPARATE file so a control command never rewrites the jobs
// document.
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

const VERSION = "1";
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 15_000;

function isParseableFile(file) {
  try { JSON.parse(readFileSync(file, "utf8")); return true; } catch { return false; }
}

function atomicWrite(file, data) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${process.pid}.${Math.floor(performance.now())}.tmp`);
  const fd = openSync(tmp, "w");
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  // Only back up a PARSEABLE main — never overwrite a good .bak with a corrupt main.
  try { if (existsSync(file) && isParseableFile(file)) copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
  renameSync(tmp, file); // atomic on same filesystem
  try { const dfd = openSync(dir, "r"); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch { /* dir fsync unsupported on some FS */ }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

export class JobStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    this.controlPath = join(dirname(filePath), "control.json");
    this.lockPath = join(dirname(filePath), "jobs.lock");
    this.jobs = new Map();
    this.meta = {};
    this.load();
  }

  load() {
    this.jobs = new Map();
    this.meta = {};
    if (!existsSync(this.filePath)) return; // fresh start
    let doc = null;
    let recoveredFromBak = false;
    try {
      doc = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      if (existsSync(`${this.filePath}.bak`)) {
        try { doc = JSON.parse(readFileSync(`${this.filePath}.bak`, "utf8")); recoveredFromBak = true; } catch { doc = null; }
      }
      if (!doc) {
        // Copy (not rename) to a sidecar and LEAVE the corrupt main in place: refusal is STICKY so a
        // supervisor restart re-detects corruption instead of finding "no file" and starting empty.
        try { copyFileSync(this.filePath, `${this.filePath}.corrupt`); } catch { /* ignore */ }
        throw new Error(`Autopilot job store is corrupt and no valid backup exists; refusing to start (copy at ${this.filePath}.corrupt). Clear ${this.filePath} to reset.`);
      }
    }
    for (const j of doc.jobs ?? []) if (j && typeof j.id === "string") this.jobs.set(j.id, j);
    this.meta = doc.meta ?? {};
    // Repair: if we fell back to .bak, rewrite the main from it so main becomes authoritative again
    // (atomicWrite skips backing up the still-corrupt main, so the good .bak is preserved).
    if (recoveredFromBak) this.save();
  }

  save() {
    atomicWrite(this.filePath, JSON.stringify({ version: VERSION, jobs: [...this.jobs.values()], meta: this.meta }, null, 2) + "\n");
  }

  upsert(job) { this.jobs.set(job.id, job); this.save(); return job; }
  get(id) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  setMeta(key, value) { this.meta[key] = value; this.save(); }

  // --- cross-process advisory lock ---
  _lockIsStale() {
    try {
      const info = JSON.parse(readFileSync(this.lockPath, "utf8"));
      const age = Date.now() - (info.at || 0);
      return !info.pid || !processAlive(info.pid) || age > LOCK_STALE_MS;
    } catch {
      // unreadable lock + exists: use file age as the staleness signal.
      try { return Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS; } catch { return true; }
    }
  }
  _tryCreateLock() {
    try { const fd = openSync(this.lockPath, "wx"); writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() })); closeSync(fd); return true; }
    catch { return false; }
  }
  _releaseLock() { try { unlinkSync(this.lockPath); } catch { /* ignore */ } }

  async withLock(fn) {
    const start = performance.now();
    for (;;) {
      if (this._tryCreateLock()) break;
      if (this._lockIsStale()) { try { unlinkSync(this.lockPath); } catch { /* lost the race; retry */ } continue; }
      if (performance.now() - start > LOCK_TIMEOUT_MS) throw new Error("Could not acquire autopilot store lock (timeout).");
      await new Promise((r) => setTimeout(r, 25));
    }
    try { return await fn(); } finally { this._releaseLock(); }
  }

  /** Synchronous lock for short critical sections (e.g. addJob). Uses a real sync sleep to back off. */
  withLockSync(fn) {
    const start = performance.now();
    const sab = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      if (this._tryCreateLock()) break;
      if (this._lockIsStale()) { try { unlinkSync(this.lockPath); } catch { /* retry */ } continue; }
      if (performance.now() - start > LOCK_TIMEOUT_MS) throw new Error("Could not acquire autopilot store lock (timeout).");
      Atomics.wait(sab, 0, 0, 25);
    }
    try { return fn(); } finally { this._releaseLock(); }
  }

  // --- control (separate file; never rewrites the jobs document) ---
  readControl() {
    try { if (existsSync(this.controlPath)) return JSON.parse(readFileSync(this.controlPath, "utf8")).control ?? "run"; } catch { /* fall through */ }
    return "run";
  }
  writeControl(v) { atomicWrite(this.controlPath, JSON.stringify({ control: v }) + "\n"); }

  removeBackup() { try { rmSync(`${this.filePath}.bak`, { force: true }); } catch { /* ignore */ } }
}
