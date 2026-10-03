import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, validateOrThrow, readJson } from "./_ajv.mjs";

const reg = validateOrThrow("tool-adapters", "schemas/tool-adapter.schema.json", "adapters/registry/adapters.json");
const ids = new Set();
for (const a of reg.adapters) {
  if (ids.has(a.id)) throw new Error(`tool-adapters: duplicate adapter id "${a.id}"`);
  ids.add(a.id);
}

// Cross-check: every tool referenced by a skill's requiredTools must exist as an adapter.
if (existsSync(join(ROOT, "skills", "registry", "skills.json"))) {
  const skills = readJson("skills/registry/skills.json");
  const missing = new Set();
  for (const s of skills.skills) for (const t of s.requiredTools || []) if (!ids.has(t)) missing.add(`${s.id}:${t}`);
  if (missing.size) throw new Error(`tool-adapters: skills reference unknown adapters: ${[...missing].join(", ")}`);
}

const impl = reg.adapters.filter((a) => a.health === "HEALTHY").length;
console.log(`OK: tool adapter registry valid — ${reg.adapters.length} adapters (${impl} HEALTHY), all skill tool refs resolve`);
