import { validateOrThrow, readJson } from "./_ajv.mjs";

const reg = validateOrThrow("skill-registry", "schemas/skill.schema.json", "skills/registry/skills.json");
const ids = new Set();
for (const s of reg.skills) {
  if (ids.has(s.id)) throw new Error(`skill-registry: duplicate skill id "${s.id}"`);
  ids.add(s.id);
}
// Cross-check: every skill referenced by an agent must exist in the skill registry.
const agents = readJson("agents/registry/agents.json");
const missing = new Set();
for (const a of agents.agents) for (const s of a.skills || []) if (!ids.has(s)) missing.add(`${a.id}:${s}`);
if (missing.size) throw new Error(`skill-registry: agent skills missing from registry: ${[...missing].join(", ")}`);
console.log(`OK: skill registry valid — ${reg.skills.length} skills, all agent-referenced skills present`);
