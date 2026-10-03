import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "./_ajv.mjs";

const required = [
  ".ai/MASTER_STATE.json",
  ".ai/BUILD_GRAPH.json",
  ".ai/NEXT_ACTIONS.md",
  ".ai/SESSION_PROTOCOL.md",
  ".ai/security/AUTHORIZATION_STATE.json",
];
for (const f of required) {
  if (!existsSync(join(ROOT, f))) throw new Error(`state: required file missing: ${f}`);
}
const master = readJson(".ai/MASTER_STATE.json");
for (const k of ["version", "product", "repository", "securityModes", "activeSecurityValidation", "integrityRules"]) {
  if (!(k in master)) throw new Error(`state: MASTER_STATE.json missing key "${k}"`);
}
// Safety invariant: no authorization => active validation must be locked.
const auth = readJson(".ai/security/AUTHORIZATION_STATE.json");
if ((auth.authorizations || []).length === 0 && master.activeSecurityValidation.state !== "LOCKED_BY_DESIGN") {
  throw new Error("state: no authorizations exist but active validation is not LOCKED_BY_DESIGN");
}
console.log("OK: .ai state present and consistent (active validation locked while no authorization exists)");
