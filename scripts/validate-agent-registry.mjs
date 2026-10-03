import { validateOrThrow } from "./_ajv.mjs";

const reg = validateOrThrow("agent-registry", "schemas/agent.schema.json", "agents/registry/agents.json");
const ids = new Set();
for (const a of reg.agents) {
  if (ids.has(a.id)) throw new Error(`agent-registry: duplicate agent id "${a.id}"`);
  ids.add(a.id);
}
// 9 guilds x 8 agents each
const perGuild = {};
for (const a of reg.agents) perGuild[a.guild] = (perGuild[a.guild] || 0) + 1;
for (const g of reg.guilds) {
  if (perGuild[g] !== 8) throw new Error(`agent-registry: guild ${g} has ${perGuild[g] || 0} agents, expected 8`);
}
if (reg.agents.length !== 72) throw new Error(`agent-registry: expected 72 agents, found ${reg.agents.length}`);
console.log(`OK: agent registry valid — 72 agents across 9 guilds, least-privilege invariants enforced by schema`);
