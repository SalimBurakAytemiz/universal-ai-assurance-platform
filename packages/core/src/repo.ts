import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Walk up from `start` until a directory containing a marker is found (default: the repo's
 * `schemas/` directory). Returns the repository root. Throws if not found within a bounded walk.
 */
export function findRepoRoot(start: string, marker = join("schemas", "policy.schema.json")): string {
  let dir = start;
  for (let i = 0; i < 16; i++) {
    if (existsSync(join(dir, marker))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate repository root (marker "${marker}") from "${start}".`);
}

/** Read and JSON-parse a file relative to the repository root. */
export function readRepoJson<T = unknown>(relPath: string, startDir: string): T {
  const root = findRepoRoot(startDir);
  return JSON.parse(readFileSync(join(root, relPath), "utf8")) as T;
}
