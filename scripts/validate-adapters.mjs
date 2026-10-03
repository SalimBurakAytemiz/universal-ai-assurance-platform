import { validateOrThrow } from "./_ajv.mjs";
const reg = validateOrThrow("tool-adapters", "schemas/tool-adapter.schema.json", "adapters/registry/adapters.json");
const ids = new Set();
for (const a of reg.adapters) {
  if (ids.has(a.id)) throw new Error(`tool-adapters: duplicate adapter id "${a.id}"`);
  ids.add(a.id);
}
console.log(`OK: tool adapter registry valid — ${reg.adapters.length} adapter(s)`);
