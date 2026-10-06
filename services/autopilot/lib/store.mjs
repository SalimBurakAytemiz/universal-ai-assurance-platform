// Durable, crash-safe job store for the autopilot.
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
// Concurrency model: a SINGLE writer. Only the running `start` loop mutates the jobs document, and
// `start` is single-instance (enforced by the atomic instance lock in cli.mjs). Other mutating
// commands refuse while a live instance holds the lock. Within the writer process an in-process
// mutex (service.mjs) serializes the async mutators tick/recover/approve; addJob is a synchronous
// single upsert on the shared in-memory map (safe under the single-writer model). This removes the whole multi-writer
// race class instead of relying on a fragile cross-process advisory lock. Control (pause/resume/
// stop) lives in a SEPARATE 1-field file and is safe to write from any process (the loop reads it).
import {
  closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const VERSION = "1";

function isParseableFile(file) {
  try { JSON.parse(readFileSync(file, "utf8")); return true; } catch { return false; }
}

function atomicWrite(file, data) {
  const dir = dirname(file);
  const base = basename(file);
  mkdirSync(dir, { recursive: true });
  // Per-write unique tmp name (own pid + monotonic counter). We deliberately do NOT sweep other
  // tmp files in the directory: several files here (jobs.json by the loop process, control.json by a
  // separate lock-free pause/resume/stop CLI process) are written concurrently, and deleting another
  // writer's in-flight tmp would make its rename fail. In-process failures are cleaned by the catch
  // below; a hard process-kill between open and rename may leave one harmless, never-read orphan tmp
  // (a cosmetic residue, documented in .ai/KNOWN_ISSUES.md), which is strictly safer than a
  // cross-writer sweep race.
  const tmp = join(dir, `.${base}.${process.pid}.${Math.floor(performance.now())}.tmp`);
  // Any failure after the tmp is created (writeSync, fsyncSync, or rename) unlinks the tmp so this
  // process never leaves its own orphan; the error still propagates.
  try {
    const fd = openSync(tmp, "w");
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    try { if (existsSync(file) && isParseableFile(file)) copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
    renameSync(tmp, file); // atomic on same filesystem
  } catch (e) {
    try { rmSync(tmp); } catch { /* best effort */ }
    throw e;
  }
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
    let recoveredFromBak = false;
    try {
      doc = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      if (existsSync(`${this.filePath}.bak`)) {
        try { doc = JSON.parse(readFileSync(`${this.filePath}.bak`, "utf8")); recoveredFromBak = true; } catch { doc = null; }
      }
      if (!doc) {
        try { copyFileSync(this.filePath, `${this.filePath}.corrupt`); } catch { /* ignore */ }
        throw new Error(`Autopilot job store is corrupt and no valid backup exists; refusing to start (copy at ${this.filePath}.corrupt). Clear ${this.filePath} to reset.`);
      }
    }
    for (const j of doc.jobs ?? []) if (j && typeof j.id === "string") this.jobs.set(j.id, j);
    this.meta = doc.meta ?? {};
    if (recoveredFromBak) this.save(); // repair main from .bak so main stays authoritative
  }

  save() {
    atomicWrite(this.filePath, JSON.stringify({ version: VERSION, jobs: [...this.jobs.values()], meta: this.meta }, null, 2) + "\n");
  }

  upsert(job) { this.jobs.set(job.id, job); this.save(); return job; }
  get(id) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); }
  setMeta(key, value) { this.meta[key] = value; this.save(); }

  readControl() {
    try { if (existsSync(this.controlPath)) return JSON.parse(readFileSync(this.controlPath, "utf8")).control ?? "run"; } catch { /* fall through */ }
    return "run";
  }
  writeControl(v) { atomicWrite(this.controlPath, JSON.stringify({ control: v }) + "\n"); }
  removeBackup() { try { rmSync(`${this.filePath}.bak`, { force: true }); } catch { /* ignore */ } }
}
