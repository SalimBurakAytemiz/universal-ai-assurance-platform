// Atomic single-instance lock for the autopilot writer process.
//
// Acquisition is atomic create-WITH-CONTENT: the pid is written to a temp file first, then the lock
// is published with linkSync() (atomic, fails EEXIST if present). The visible lock is therefore
// NEVER empty — so a racer can always read a real pid and do a liveness check, closing the
// "create-then-write" window where an empty lock could be mistaken for stale and stolen.
//
// A stale lock (dead holder) is reclaimed by ATOMICALLY renaming it away: only one racer's rename
// of a given source can succeed, so two processes can never both win the reclaim. An unparseable
// lock is treated as a LIVE mid-operation holder unless it is older than a grace window (then it is
// a genuine abandoned/corrupt lock and is reclaimed). Release is ownership-checked.
import { linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

const STALE_UNPARSEABLE_MS = 5000;

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** @returns {boolean} true if this process now holds the lock. */
export function acquireInstanceLock(lockPath) {
  for (let i = 0; i < 5; i++) {
    const tmp = `${lockPath}.acq.${process.pid}.${Date.now()}.${i}`;
    try { writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: Date.now() })); } catch { return false; }
    try { linkSync(tmp, lockPath); rmSync(tmp, { force: true }); return true; } // atomic publish-with-content
    catch { try { rmSync(tmp, { force: true }); } catch { /* ignore */ } }

    // lockPath already exists — decide whether its holder is stale.
    let stale = false;
    try {
      const info = JSON.parse(readFileSync(lockPath, "utf8"));
      stale = !info.pid || !processAlive(info.pid);
    } catch {
      // Unparseable: a holder mid-operation is LIVE; only an AGED unparseable lock is abandoned.
      try { stale = Date.now() - statSync(lockPath).mtimeMs > STALE_UNPARSEABLE_MS; } catch { stale = false; }
    }
    if (!stale) return false; // a live holder (including the create-with-content window) holds it

    // Atomic steal: rename the stale file away. Only ONE racer's rename of this source can succeed.
    const steal = `${lockPath}.steal.${process.pid}.${Date.now()}`;
    try { renameSync(lockPath, steal); rmSync(steal, { force: true }); } catch { /* lost the steal; retry */ }
  }
  return false;
}

/** Release only if THIS process owns the lock (never delete someone else's live lock). */
export function releaseInstanceLock(lockPath) {
  try { const info = JSON.parse(readFileSync(lockPath, "utf8")); if (info.pid === process.pid) rmSync(lockPath, { force: true }); }
  catch { /* not ours / already gone */ }
}

/** Is a live instance currently holding the lock? (for other commands to refuse concurrent mutation) */
export function liveInstanceHeld(lockPath) {
  try { const info = JSON.parse(readFileSync(lockPath, "utf8")); return !!info.pid && processAlive(info.pid); }
  catch { return false; }
}
