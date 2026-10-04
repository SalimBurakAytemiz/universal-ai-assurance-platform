import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, releaseInstanceLock, liveInstanceHeld, clearStaleLock } from "../lib/instancelock.mjs";

let lockPath;
beforeEach(() => { lockPath = join(mkdtempSync(join(tmpdir(), "uaap-lock-")), "x.lock"); });

describe("instance lock — atomic acquire, no auto-steal (no double-win by construction)", () => {
  it("acquires, blocks a second acquire while held, releases", () => {
    expect(acquireInstanceLock(lockPath)).toBe(true);
    expect(acquireInstanceLock(lockPath)).toBe(false); // held -> refuse (never steals)
    expect(liveInstanceHeld(lockPath)).toBe(true);
    releaseInstanceLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
    expect(acquireInstanceLock(lockPath)).toBe(true);
  });

  it("REFUSES (fail-closed) when any lock is present — even a stale one — rather than stealing it", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, at: Date.now() })); // dead-pid (stale) lock
    expect(acquireInstanceLock(lockPath)).toBe(false); // safe refusal, NOT an automatic steal
    expect(existsSync(lockPath)).toBe(true); // the existing lock is never deleted by acquire
  });

  it("release is ownership-checked (never deletes another process's lock)", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, at: Date.now() })); // not ours
    releaseInstanceLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("clearStaleLock removes a provably-dead lock, then acquire succeeds", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, at: Date.now() })); // dead pid
    expect(clearStaleLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(acquireInstanceLock(lockPath)).toBe(true);
  });

  it("clearStaleLock does NOT remove a LIVE lock (this process)", () => {
    expect(acquireInstanceLock(lockPath)).toBe(true); // live, held by us
    expect(clearStaleLock(lockPath)).toBe(false); // refuses to clear a live holder
    expect(existsSync(lockPath)).toBe(true);
  });

  it("clearStaleLock removes a torn/unparseable lock", () => {
    writeFileSync(lockPath, ""); // torn lock from a crash
    expect(clearStaleLock(lockPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });
});
