import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireInstanceLock, releaseInstanceLock, liveInstanceHeld } from "../lib/instancelock.mjs";

let lockPath;
beforeEach(() => { lockPath = join(mkdtempSync(join(tmpdir(), "uaap-lock-")), "x.lock"); });

describe("instance lock (atomic single-instance)", () => {
  it("acquires, blocks a second live acquire, then releases", () => {
    expect(acquireInstanceLock(lockPath)).toBe(true);
    // a live holder (this process) => a second acquire by "another" must fail. Simulate another
    // process by writing a live-pid lock and attempting acquire (our own pid is alive, counts as held).
    expect(acquireInstanceLock(lockPath)).toBe(false);
    expect(liveInstanceHeld(lockPath)).toBe(true);
    releaseInstanceLock(lockPath);
    expect(existsSync(lockPath)).toBe(false);
    expect(acquireInstanceLock(lockPath)).toBe(true);
  });

  it("reclaims a STALE lock (dead pid) atomically", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, at: Date.now() })); // almost-certainly-dead pid
    expect(liveInstanceHeld(lockPath)).toBe(false);
    expect(acquireInstanceLock(lockPath)).toBe(true); // reclaimed
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });

  it("release is ownership-checked (never deletes another process's live lock)", () => {
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, at: Date.now() })); // not ours
    releaseInstanceLock(lockPath); // must NOT delete someone else's lock
    expect(existsSync(lockPath)).toBe(true);
  });

  it("does NOT steal a FRESH empty/unparseable lock (live mid-create), but DOES reclaim an aged one", () => {
    writeFileSync(lockPath, ""); // fresh empty = a holder in its create window
    expect(acquireInstanceLock(lockPath)).toBe(false);
    const old = Date.now() / 1000 - 3600; // age it past the grace window
    utimesSync(lockPath, old, old);
    expect(acquireInstanceLock(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
  });
});
