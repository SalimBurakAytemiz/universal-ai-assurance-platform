import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ajv, readJson } from "./_ajv.mjs";

const dir = join(ROOT, "knowledge");
if (!existsSync(dir)) {
  console.log("OK: no knowledge/ items yet (schema is present for when the knowledge store is built)");
  // still confirm the schema itself compiles
  ajv.compile(readJson("schemas/knowledge-item.schema.json"));
  process.exit(0);
}
const validate = ajv.compile(readJson("schemas/knowledge-item.schema.json"));
let count = 0;
for (const f of readdirSync(dir)) {
  if (!f.endsWith(".json")) continue;
  const item = readJson(join("knowledge", f));
  if (!validate(item)) throw new Error(`knowledge: ${f} invalid: ${JSON.stringify(validate.errors)}`);
  count++;
}
console.log(`OK: ${count} knowledge item(s) valid`);
