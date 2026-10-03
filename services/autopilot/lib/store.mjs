// Durable, crash-safe job store for the autopilot. One JSON document, written atomically
// (temp file + rename) so a crash never leaves a torn file. State survives process restart:
// a new JobStore over the same path reloads every persisted job.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const VERSION = "1";

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {string} name          handler/task name
 * @property {"deterministic"|"ai"} kind
 * @property {string} state         RuntimeState
 * @property {string[]} dependsOn
 * @property {number} attempts
 * @property {number} maxAttempts
 * @property {string|null} nextRetryAt
 * @property {unknown} [result]
 * @property {string|null} [error]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export class JobStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    /** @type {Map<string, Job>} */
    this.jobs = new Map();
    /** @type {Record<string, unknown>} */
    this.meta = {};
    this.load();
  }

  load() {
    this.jobs = new Map();
    this.meta = {};
    if (!existsSync(this.filePath)) return;
    try {
      const doc = JSON.parse(readFileSync(this.filePath, "utf8"));
      for (const j of doc.jobs ?? []) {
        if (j && typeof j.id === "string") this.jobs.set(j.id, j);
      }
      this.meta = doc.meta ?? {};
    } catch {
      // A corrupt store is treated as empty rather than crashing the service (fail-safe load).
      this.jobs = new Map();
    }
  }

  save() {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const doc = { version: VERSION, jobs: [...this.jobs.values()], meta: this.meta };
    const tmp = join(dirname(this.filePath), `.jobs.${process.pid}.${Math.floor(performance.now())}.tmp`);
    try {
      writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
      renameSync(tmp, this.filePath); // atomic on same filesystem
    } catch (e) {
      try { rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw e;
    }
  }

  /** @param {Job} job */
  upsert(job) {
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  get(id) {
    return this.jobs.get(id);
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  setMeta(key, value) {
    this.meta[key] = value;
    this.save();
  }
}
