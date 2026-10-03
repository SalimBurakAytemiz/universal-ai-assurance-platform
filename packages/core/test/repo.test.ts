import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot, readRepoJson } from "@uaap/core";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("repo helpers", () => {
  it("finds the repository root from this test file's directory", () => {
    const root = findRepoRoot(HERE);
    expect(typeof root).toBe("string");
  });

  it("throws when no marker is found (fail-closed, bounded walk)", () => {
    expect(() => findRepoRoot(tmpdir(), "definitely-not-a-real-marker-xyz.json")).toThrow();
  });

  it("reads and parses a repo JSON file relative to root", () => {
    const pkg = readRepoJson<{ name: string }>("package.json", HERE);
    expect(pkg.name).toBe("universal-ai-assurance-platform");
  });
});
