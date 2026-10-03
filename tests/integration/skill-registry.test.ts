import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const skills = JSON.parse(
  readFileSync(new URL("../../skills/registry/skills.json", import.meta.url), "utf8"),
) as { skills: { id: string; riskClass: string }[] };
const agents = JSON.parse(
  readFileSync(new URL("../../agents/registry/agents.json", import.meta.url), "utf8"),
) as { agents: { skills?: string[] }[] };

describe("Skill registry", () => {
  it("has unique skill ids", () => {
    const ids = skills.skills.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers every skill referenced by an agent (no dangling skill reference)", () => {
    const known = new Set(skills.skills.map((s) => s.id));
    const missing: string[] = [];
    for (const a of agents.agents) for (const s of a.skills ?? []) if (!known.has(s)) missing.push(s);
    expect(missing).toEqual([]);
  });

  it("assigns every skill a risk class within the allowed set (never R3)", () => {
    const allowed = new Set(["R0_PASSIVE", "R1_LOW_IMPACT", "R2_ELEVATED"]);
    const offenders = skills.skills.filter((s) => !allowed.has(s.riskClass)).map((s) => `${s.id}:${s.riskClass}`);
    expect(offenders).toEqual([]);
  });
});
