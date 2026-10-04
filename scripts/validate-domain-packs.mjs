import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ajv, readJson } from "./_ajv.mjs";

const validate = ajv.compile(readJson("schemas/domain-pack.schema.json")); // compile ONCE
const dir = join(ROOT, "domain-packs");
const ids = new Set();
let count = 0, hasGeneric = false;
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  const p = readJson(join("domain-packs", f));
  if (!validate(p)) throw new Error(`domain-packs: ${f} invalid: ${JSON.stringify(validate.errors)}`);
  if (ids.has(p.id)) throw new Error(`domain-packs: duplicate id "${p.id}"`);
  ids.add(p.id);
  if (p.generic) hasGeneric = true;
  count++;
}
if (!hasGeneric) throw new Error("domain-packs: a generic fallback pack is required");
// Fail on a signal shared by more than one non-generic pack (forces disambiguation).
const sigOwners = {};
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  const p = readJson(join("domain-packs", f));
  if (p.generic) continue;
  for (const sig of new Set(p.signals ?? [])) (sigOwners[sig] ??= []).push(p.id);
}
const collisions = Object.entries(sigOwners).filter(([, owners]) => owners.length > 1);
if (collisions.length) throw new Error(`domain-packs: signals shared across packs (ambiguous): ${collisions.map(([s, o]) => `${s}=>${o.join("/")}`).join(", ")}`);

console.log(`OK: ${count} domain pack(s) valid (generic fallback present)`);
