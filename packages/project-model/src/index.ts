import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newId, type Environment, type Mode } from "@uaap/core";

export const TargetKind = {
  WEB: "WEB",
  API: "API",
  DATABASE: "DATABASE",
  SOCKET: "SOCKET",
  MOBILE: "MOBILE",
  DESKTOP: "DESKTOP",
  OTHER: "OTHER",
} as const;
export type TargetKind = (typeof TargetKind)[keyof typeof TargetKind];

export interface RepositoryRef {
  readonly id: string;
  readonly kind: "git" | "local";
  readonly path: string;
  readonly remote?: string;
}

export interface ProjectTarget {
  readonly id: string;
  readonly name: string;
  readonly kind: TargetKind;
  readonly identifiers: readonly string[];
  readonly environment: Environment;
  readonly baseUrl?: string;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly mode: Mode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly repositories: readonly RepositoryRef[];
  readonly targets: readonly ProjectTarget[];
}

/** A project id must be a single safe filename segment (also the shape newId produces). */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * File-backed project/target persistence (local-first). One JSON document per project under
 * `<baseDir>/<id>.json`. Pure and deterministic given an injected `now` (no wall-clock reads).
 *
 * Note: this is a single-process, local-first store. It does not coordinate concurrent writers
 * across processes; see .ai/KNOWN_ISSUES.md (PROJECT-STORE-CONCURRENCY). Writes are atomic
 * (temp file + rename) so a crash cannot leave a torn file.
 */
export class ProjectStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  /** Resolve a project id to its file, rejecting anything that is not a safe single segment. */
  private file(id: string): string {
    if (typeof id !== "string" || !SAFE_ID.test(id)) {
      throw new Error(`Invalid project id "${String(id)}" (must match ${SAFE_ID}).`);
    }
    return join(this.baseDir, `${id}.json`);
  }

  createProject(input: { name: string; mode: Mode; now: string }): Project {
    if (!input.name.trim()) throw new Error("Project name is required.");
    const project: Project = {
      id: newId("PRJ"),
      name: input.name,
      mode: input.mode,
      createdAt: input.now,
      updatedAt: input.now,
      repositories: [],
      targets: [],
    };
    this.save(project);
    return project;
  }

  save(project: Project): void {
    const target = this.file(project.id); // validates id
    const tmp = join(this.baseDir, `.${project.id}.${newId("w")}.tmp`);
    writeFileSync(tmp, JSON.stringify(project, null, 2) + "\n");
    renameSync(tmp, target); // atomic on the same filesystem
  }

  get(id: string): Project | undefined {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    return JSON.parse(readFileSync(f, "utf8")) as Project;
  }

  /** List projects; a single corrupt/foreign file is skipped rather than breaking enumeration. */
  list(): Project[] {
    if (!existsSync(this.baseDir)) return [];
    const out: Project[] = [];
    for (const f of readdirSync(this.baseDir)) {
      if (!f.endsWith(".json") || f.startsWith(".")) continue;
      try {
        const p = JSON.parse(readFileSync(join(this.baseDir, f), "utf8")) as Project;
        if (p && typeof p.id === "string" && typeof p.name === "string") out.push(p);
      } catch {
        // skip unparseable / partially written files; one bad file must not hide the rest.
      }
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  private mutate(id: string, now: string, fn: (p: Project) => Project): Project {
    const existing = this.get(id);
    if (!existing) throw new Error(`No such project "${id}".`);
    const next = { ...fn(existing), updatedAt: now };
    this.save(next);
    return next;
  }

  addRepository(projectId: string, repo: Omit<RepositoryRef, "id">, now: string): Project {
    return this.mutate(projectId, now, (p) => ({
      ...p,
      // generated id LAST so a caller-supplied id can never clobber it.
      repositories: [...p.repositories, { ...repo, id: newId("REPO") }],
    }));
  }

  addTarget(projectId: string, target: Omit<ProjectTarget, "id">, now: string): Project {
    if (target.identifiers.length === 0) throw new Error("A target must have at least one identifier.");
    return this.mutate(projectId, now, (p) => ({
      ...p,
      targets: [...p.targets, { ...target, id: newId("TGT") }],
    }));
  }
}
