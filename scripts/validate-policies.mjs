import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, validateOrThrow } from "./_ajv.mjs";

let count = 0;
for (const f of readdirSync(join(ROOT, "policies"))) {
  if (!f.endsWith(".json")) continue;
  validateOrThrow("policies", "schemas/policy.schema.json", join("policies", f));
  count++;
}
console.log(`OK: ${count} policy document(s) valid against schemas/policy.schema.json`);
