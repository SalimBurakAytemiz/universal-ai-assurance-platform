// Atomic single-instance lock for the autopilot writer process.
//
// Correctness by construction: the ONLY path to acquiring the lock is an atomic create-with-content
// (write pid to a temp file, then publish with linkSync(), which fails EEXIST if the lock exists).
// `acquire` NEVER deletes or renames an existing lock, so two processes can never both hold it and a
// live holder's lock is never removed out from under it — eliminating the stale-reclaim TOCTOU class
// entirely. A stale lock left by a HARD crash therefore causes a SAFE refusal (fail-closed), not a
// double-win; it is cleared by an explicit operator action (`clearStaleLock`, exposed as the CLI
// `clear` command) which only removes a lock whose holder is provably dead. Release is
// ownership-checked. This favors "refuse to start" over "risk duplicate commit/PR/merge".
import { closeSync, linkSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";

export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** @returns {boolean} true if this process now holds the lock. Only ever succeeds via atomic create. */
export function acquireInstanceLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, at: Date.now() });
  const tmp = `${lockPath}.acq.${process.pid}.${Date.now()}`;
  try { writeFileSync(tmp, payload); } catch { return false; }
  try {
    linkSync(tmp, lockPath); // atomic publish-with-content; EEXIST if a lock is present
    return true;
  } catch (e) {
    if (e && e.code === "EEXIST") return false; // held (live or stale) -> refuse; never steal
    // Filesystem without hardlink support: fall back to atomic O_EXCL create (still never steals).
    try { const fd = openSync(lockPath, "wx"); writeSync(fd, payload); closeSync(fd); return true; }
    catch { return false; }
  } finally {
    try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

/** Release only if THIS process owns the lock (never delete someone else's live lock). */
export function releaseInstanceLock(lockPath) {
  try { const info = JSON.parse(readFileSync(lockPath, "utf8")); if (info.pid === process.pid) rmSync(lockPath, { force: true }); }
  catch { /* not ours / already gone */ }
}

/** Is a live instance currently holding the lock? */
export function liveInstanceHeld(lockPath) {
  try { const info = JSON.parse(readFileSync(lockPath, "utf8")); return !!info.pid && processAlive(info.pid); }
  catch { return false; }
}

/**
 * Explicit, operator-invoked cleanup of a lock left by a hard crash. Removes the lock ONLY if its
 * holder is provably dead (or it is unparseable — a torn lock from a crash). Returns whether it was
 * cleared. This is NOT called from the concurrent `start` path; run it when no instance is running.
 */
export function clearStaleLock(lockPath) {
  let held;
  try { held = JSON.parse(readFileSync(lockPath, "utf8")); } catch { held = null; }
  if (held && held.pid && processAlive(held.pid)) return false; // a live instance holds it — keep it
  try { rmSync(lockPath, { force: true }); return true; } catch { return false; }
}
