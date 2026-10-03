#!/usr/bin/env node
// Generates skills/registry/skills.json from the distinct skills referenced across the 72
// agents. Deterministic; safe to re-run. New technology should be added as a new skill here
// (and referenced by an agent), not as a new canonical agent.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const agents = JSON.parse(readFileSync(join(ROOT, "agents/registry/agents.json"), "utf8"));

// Skills that imply a deterministic tool adapter.
// Each tool id here MUST exist in adapters/registry/adapters.json (enforced by
// scripts/validate-adapters.mjs). Deterministic schema validation maps to schema-adapter.
const TOOL_FOR = {
  playwright: ["playwright-adapter"],
  "selenium-compat": ["selenium-adapter"],
  appium: ["appium-adapter"],
  ajv: ["schema-adapter"],
  "json-schema": ["schema-adapter"],
  openapi: ["schema-adapter"],
  "k6-smoke": ["k6-adapter"],
  "db-readonly-validation": ["database-readonly-adapter"],
  git: ["git-adapter"],
  "github-pr": ["github-adapter"],
  hashing: ["hash-adapter"],
};
// Skills that are inherently active (elevated) vs low-impact vs passive.
const ELEVATED = new Set(["authorized-appsec", "authz-testing", "sandbox-fault-injection"]);
const PASSIVE = new Set([
  "passive-osint", "security-txt", "public-exposure", "dns-metadata", "certificate-metadata",
  "owasp", "cwe", "nist", "attack", "cve-correlation", "advisory", "technology-research",
  "doc-research", "repo-research", "license-review", "knowledge-curation", "provenance",
  "orchestration", "run-planning", "dependency-planning", "authorization", "scope-matching",
  "policy-as-code", "approval-workflow", "audit", "chain-of-custody", "scheduling",
  "budget-guard", "hashing", "control-mapping", "technical-reporting", "executive-reporting",
  "risk-hypothesis", "release-decision", "risk-acceptance", "rca", "evidence-chaining", "checkpoint", "recovery",
]);

const skillIds = new Set();
for (const a of agents.agents) for (const s of a.skills || []) skillIds.add(s);

const skills = [...skillIds].sort().map((id) => ({
  id,
  version: "0.1.0",
  capabilities: [id],
  requiredTools: TOOL_FOR[id] ?? [],
  knowledgeRefs: [],
  riskClass: ELEVATED.has(id) ? "R2_ELEVATED" : PASSIVE.has(id) ? "R0_PASSIVE" : "R1_LOW_IMPACT",
  evaluation: "default",
}));

mkdirSync(join(ROOT, "skills/registry"), { recursive: true });
writeFileSync(join(ROOT, "skills/registry/skills.json"), JSON.stringify({ version: "0.1.0", skills }, null, 2) + "\n");
console.log(`Wrote ${skills.length} skills referenced by the agent registry.`);
