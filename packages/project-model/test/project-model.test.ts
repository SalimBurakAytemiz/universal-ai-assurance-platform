import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Environment, Mode } from "@uaap/core";
import { ProjectStore, TargetKind } from "@uaap/project-model";

const T1 = "2026-10-03T10:00:00.000Z";
const T2 = "2026-10-03T11:00:00.000Z";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uaap-proj-"));
});

describe("ProjectStore", () => {
  it("creates and persists a project that survives a fresh store (restart)", () => {
    const store = new ProjectStore(dir);
    const p = store.createProject({ name: "Checkout Service", mode: Mode.INTERNAL_OWNED, now: T1 });
    expect(p.id).toMatch(/^PRJ_/);

    const reopened = new ProjectStore(dir).get(p.id);
    expect(reopened?.name).toBe("Checkout Service");
    expect(reopened?.mode).toBe(Mode.INTERNAL_OWNED);
    expect(reopened?.targets).toEqual([]);
  });

  it("rejects an empty project name", () => {
    const store = new ProjectStore(dir);
    expect(() => store.createProject({ name: "   ", mode: Mode.INTERNAL_OWNED, now: T1 })).toThrow();
  });

  it("adds repositories and targets and bumps updatedAt", () => {
    const store = new ProjectStore(dir);
    const p = store.createProject({ name: "Shop", mode: Mode.CLIENT_AUTHORIZED, now: T1 });
    store.addRepository(p.id, { kind: "git", path: "/repo", remote: "https://example/repo.git" }, T2);
    const updated = store.addTarget(
      p.id,
      { name: "API staging", kind: TargetKind.API, identifiers: ["api.example.com"], environment: Environment.STAGING },
      T2,
    );
    expect(updated.repositories).toHaveLength(1);
    expect(updated.targets).toHaveLength(1);
    expect(updated.targets[0]!.id).toMatch(/^TGT_/);
    expect(updated.updatedAt).toBe(T2);
    expect(updated.createdAt).toBe(T1);
  });

  it("rejects a target with no identifiers", () => {
    const store = new ProjectStore(dir);
    const p = store.createProject({ name: "X", mode: Mode.INTERNAL_OWNED, now: T1 });
    expect(() =>
      store.addTarget(p.id, { name: "bad", kind: TargetKind.WEB, identifiers: [], environment: Environment.DEV }, T2),
    ).toThrow();
  });

  it("throws when mutating a non-existent project", () => {
    const store = new ProjectStore(dir);
    expect(() =>
      store.addTarget("PRJ_missing", { name: "x", kind: TargetKind.WEB, identifiers: ["x"], environment: Environment.DEV }, T2),
    ).toThrow();
  });

  it("lists projects in creation order", () => {
    const store = new ProjectStore(dir);
    store.createProject({ name: "A", mode: Mode.INTERNAL_OWNED, now: T1 });
    store.createProject({ name: "B", mode: Mode.INTERNAL_OWNED, now: T2 });
    expect(store.list().map((p) => p.name)).toEqual(["A", "B"]);
  });
});
