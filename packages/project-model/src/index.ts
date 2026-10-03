import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/**
 * File-backed project/target persistence (local-first). One JSON document per project under
 * `<baseDir>/<id>.json`. Pure and deterministic given an injected `now` (no wall-clock reads),
 * so project state survives restarts and is reproducible in tests.
 */
export class ProjectStore {
  constructor(private readonly baseDir: string) {
    mkdirSync(this.baseDir, { recursive: true });
  }

  private file(id: string): string {
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
    writeFileSync(this.file(project.id), JSON.stringify(project, null, 2) + "\n");
  }

  get(id: string): Project | undefined {
    const f = this.file(id);
    if (!existsSync(f)) return undefined;
    return JSON.parse(readFileSync(f, "utf8")) as Project;
  }

  list(): Project[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.baseDir, f), "utf8")) as Project)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
      repositories: [...p.repositories, { id: newId("REPO"), ...repo }],
    }));
  }

  addTarget(projectId: string, target: Omit<ProjectTarget, "id">, now: string): Project {
    if (target.identifiers.length === 0) throw new Error("A target must have at least one identifier.");
    return this.mutate(projectId, now, (p) => ({
      ...p,
      targets: [...p.targets, { id: newId("TGT"), ...target }],
    }));
  }
}
