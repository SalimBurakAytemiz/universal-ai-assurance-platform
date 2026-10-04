// Atomic single-instance lock for the autopilot writer process.
//
// Acquisition is O_EXCL (atomic). A stale lock (dead holder) is reclaimed by ATOMICALLY renaming
// the stale file away: only one racer's rename of a given source can succeed, so two processes can
// never both "win" the reclaim (the TOCTOU in a blind unlink is avoided). Release is
// ownership-checked, so a process never deletes a lock it does not hold.
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** @returns {boolean} true if this process now holds the lock. */
export function acquireInstanceLock(lockPath) {
  for (let i = 0; i < 4; i++) {
    try {
      const fd = openSync(lockPath, "wx"); // atomic create-exclusive
      writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      closeSync(fd);
      return true;
    } catch {
      let stale = false;
      try { const info = JSON.parse(readFileSync(lockPath, "utf8")); stale = !info.pid || !processAlive(info.pid); }
      catch { stale = true; } // unreadable/partial lock -> treat as stale
      if (!stale) return false; // a live instance holds it
      // Atomic steal: rename the stale file to a unique name. Only ONE racer's rename succeeds;
      // the loser gets ENOENT and retries the O_EXCL create (which then has a single winner).
      const steal = `${lockPath}.steal.${process.pid}.${Date.now()}`;
      try { renameSync(lockPath, steal); rmSync(steal, { force: true }); } catch { /* lost the steal race; retry */ }
    }
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
