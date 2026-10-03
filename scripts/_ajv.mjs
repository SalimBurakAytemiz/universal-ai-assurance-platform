// Shared Ajv loader + helpers for validator scripts.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ajv = new Ajv2020({ allErrors: true, strict: false });

export function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), "utf8"));
}

export function validateOrThrow(label, schemaRel, dataRel) {
  const validate = ajv.compile(readJson(schemaRel));
  const data = readJson(dataRel);
  if (!validate(data)) {
    const msg = (validate.errors || []).map((e) => `  - ${e.instancePath || "/"} ${e.message}`).join("\n");
    throw new Error(`${label}: schema validation FAILED for ${dataRel}:\n${msg}`);
  }
  return data;
}
