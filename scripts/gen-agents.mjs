#!/usr/bin/env node
// Generates agents/registry/agents.json — the 72 canonical agent role definitions
// (9 guilds x 8). Deterministic; safe to re-run. Agents are ROLE definitions, not live LLMs.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const GUILDS = [
  "COMMAND_AND_GOVERNANCE",
  "PROJECT_INTELLIGENCE",
  "QUALITY_ENGINEERING",
  "SECURITY_ASSURANCE",
  "DATA_PERF_RELIABILITY_PRIVACY",
  "EVIDENCE_VERIFICATION_REMEDIATION",
  "KNOWLEDGE_AND_LEARNING",
  "AUTOMATION_AND_INFRASTRUCTURE",
  "BUSINESS_DOMAIN_REPORTING",
];

// [name, riskCeiling, canDetect, skills...]
const ROLES = {
  COMMAND_AND_GOVERNANCE: [
    ["Master Orchestrator", "R0_PASSIVE", false, ["orchestration", "run-planning"]],
    ["Build Graph Planner", "R0_PASSIVE", false, ["dependency-planning"]],
    ["Authorization Gate", "R0_PASSIVE", false, ["authorization", "fail-closed"]],
    ["Scope Resolver", "R0_PASSIVE", false, ["scope-matching"]],
    ["Policy Decision", "R0_PASSIVE", false, ["policy-as-code"]],
    ["Human Approval Coordinator", "R0_PASSIVE", false, ["approval-workflow"]],
    ["Audit And Provenance", "R0_PASSIVE", false, ["audit", "chain-of-custody"]],
    ["Runtime Scheduler", "R0_PASSIVE", false, ["scheduling", "budget-guard"]],
  ],
  PROJECT_INTELLIGENCE: [
    ["Repository Intelligence", "R1_LOW_IMPACT", true, ["repo-scan", "sbom"]],
    ["Architecture Discovery", "R1_LOW_IMPACT", true, ["architecture-mapping"]],
    ["Technology Stack Intelligence", "R1_LOW_IMPACT", true, ["tech-detection"]],
    ["Dependency Graph", "R1_LOW_IMPACT", true, ["dependency-graph"]],
    ["Domain Discovery", "R1_LOW_IMPACT", true, ["domain-detection"]],
    ["Capability Mapping", "R1_LOW_IMPACT", true, ["capability-mapping"]],
    ["Business Flow Discovery", "R1_LOW_IMPACT", true, ["flow-discovery"]],
    ["Digital Twin Steward", "R1_LOW_IMPACT", false, ["twin-stewardship", "provenance"]],
  ],
  QUALITY_ENGINEERING: [
    ["API Contract", "R1_LOW_IMPACT", true, ["ajv", "json-schema", "openapi", "negative-testing", "schema-drift"]],
    ["Web UI Automation", "R1_LOW_IMPACT", true, ["playwright", "selenium-compat", "a11y-selectors"]],
    ["Mobile Quality", "R1_LOW_IMPACT", true, ["appium", "android", "deep-link", "push-notification"]],
    ["Database And Migration Quality", "R1_LOW_IMPACT", true, ["db-readonly-validation", "migrations"]],
    ["Realtime Event Queue Quality", "R1_LOW_IMPACT", true, ["websocket", "kafka", "queue-patterns"]],
    ["Visual And Accessibility Quality", "R1_LOW_IMPACT", true, ["visual-regression", "accessibility", "localization"]],
    ["Test Generation And Property", "R1_LOW_IMPACT", true, ["property-based", "mutation-testing", "state-machine"]],
    ["Regression And Flaky Test", "R1_LOW_IMPACT", true, ["regression-selection", "flaky-analysis", "concurrency", "idempotency"]],
  ],
  SECURITY_ASSURANCE: [
    ["Prospect Intelligence", "R0_PASSIVE", true, ["passive-osint", "security-txt", "public-exposure"]],
    ["Public Asset And Technology Intelligence", "R0_PASSIVE", true, ["dns-metadata", "certificate-metadata"]],
    ["Application Security", "R2_ELEVATED", true, ["web-security", "authorized-appsec"]],
    ["API Security", "R2_ELEVATED", true, ["api-security", "authz-testing"]],
    ["Identity Access And Session Security", "R2_ELEVATED", true, ["identity", "session", "business-logic"]],
    ["Source Dependency Secrets Supply Chain Security", "R1_LOW_IMPACT", true, ["sast-patterns", "dependency-audit", "secret-scan", "supply-chain"]],
    ["Cloud Infra IAM Container IaC TLS Security", "R1_LOW_IMPACT", true, ["cloud-config", "iam-review", "container", "iac", "tls-config"]],
    ["Data Protection Cryptography Exposure Security", "R1_LOW_IMPACT", true, ["encryption-at-rest", "encryption-in-transit", "key-management", "exposure-review"]],
  ],
  DATA_PERF_RELIABILITY_PRIVACY: [
    ["Data Integrity And Reconciliation", "R1_LOW_IMPACT", true, ["cross-system-reconciliation", "ledger-consistency"]],
    ["Performance Engineering", "R1_LOW_IMPACT", true, ["k6-smoke", "threshold-based"]],
    ["Reliability Engineering", "R1_LOW_IMPACT", true, ["retry", "timeout", "circuit-breaker"]],
    ["Controlled Fault Injection", "R2_ELEVATED", true, ["sandbox-fault-injection"]],
    ["Backup Restore Disaster Recovery", "R1_LOW_IMPACT", true, ["backup-verification", "restore", "rollback"]],
    ["Privacy And PII Assurance", "R1_LOW_IMPACT", true, ["pii-detection", "masking", "retention"]],
    ["Observability Correlation", "R1_LOW_IMPACT", true, ["trace-correlation", "metrics"]],
    ["SLO SLA Assurance", "R1_LOW_IMPACT", true, ["slo", "sla"]],
  ],
  EVIDENCE_VERIFICATION_REMEDIATION: [
    ["Evidence Collector", "R1_LOW_IMPACT", false, ["artifact-capture", "trace-capture"]],
    ["Evidence Integrity", "R0_PASSIVE", false, ["hashing", "chain-of-custody"]],
    ["Finding Verifier", "R1_LOW_IMPACT", false, ["independent-verification"]],
    ["False Positive Challenger", "R1_LOW_IMPACT", false, ["adversarial-review"]],
    ["Root Cause Analysis", "R0_PASSIVE", false, ["rca", "evidence-chaining"]],
    ["Remediation", "R1_LOW_IMPACT", false, ["patch-strategy", "pr-authoring"]],
    ["Independent Regression Validator", "R1_LOW_IMPACT", false, ["regression-retest"]],
    ["Release Gate", "R0_PASSIVE", false, ["release-decision", "risk-acceptance"]],
  ],
  KNOWLEDGE_AND_LEARNING: [
    ["Technology Scout", "R0_PASSIVE", false, ["technology-research"]],
    ["Standards Intelligence", "R0_PASSIVE", false, ["owasp", "cwe", "nist", "attack"]],
    ["Vulnerability And Advisory Intelligence", "R0_PASSIVE", false, ["cve-correlation", "advisory"]],
    ["Documentation Research", "R0_PASSIVE", false, ["doc-research"]],
    ["Open Source Research", "R0_PASSIVE", false, ["repo-research", "license-review"]],
    ["Knowledge Curator", "R0_PASSIVE", false, ["knowledge-curation", "provenance"]],
    ["Sandbox Experiment", "R1_LOW_IMPACT", false, ["sandbox-benchmark"]],
    ["Agent Evaluation And Certification", "R0_PASSIVE", false, ["agent-benchmark", "certification"]],
  ],
  AUTOMATION_AND_INFRASTRUCTURE: [
    ["Git And GitHub Lifecycle", "R1_LOW_IMPACT", false, ["git", "github-pr", "safe-merge"]],
    ["CICD Build", "R1_LOW_IMPACT", false, ["ci", "build"]],
    ["Environment Manager", "R1_LOW_IMPACT", false, ["environment", "drift-detection"]],
    ["Worker Infrastructure", "R1_LOW_IMPACT", false, ["worker-orchestration"]],
    ["Device Lab", "R1_LOW_IMPACT", false, ["device-matrix", "emulator"]],
    ["Integration Broker", "R1_LOW_IMPACT", false, ["integration-dry-run"]],
    ["Packaging And Update", "R1_LOW_IMPACT", false, ["packaging", "update-rollback"]],
    ["Recovery And Continuity", "R0_PASSIVE", false, ["checkpoint", "recovery"]],
  ],
  BUSINESS_DOMAIN_REPORTING: [
    ["Domain Specialist Coordinator", "R0_PASSIVE", false, ["domain-pack-binding"]],
    ["Business Rules Intelligence", "R1_LOW_IMPACT", true, ["business-invariants"]],
    ["Critical Journey", "R1_LOW_IMPACT", true, ["critical-journey-modeling"]],
    ["Synthetic Test Data", "R1_LOW_IMPACT", false, ["synthetic-data"]],
    ["Risk And Compliance Mapping", "R0_PASSIVE", false, ["control-mapping"]],
    ["Technical Report", "R0_PASSIVE", false, ["technical-reporting"]],
    ["Executive And Customer Assurance", "R0_PASSIVE", false, ["executive-reporting"]],
    ["Incident Replay And Change Impact", "R1_LOW_IMPACT", true, ["incident-replay", "change-impact", "blast-radius"]],
  ],
};

const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const guildPrefix = {
  COMMAND_AND_GOVERNANCE: "gov",
  PROJECT_INTELLIGENCE: "proj",
  QUALITY_ENGINEERING: "qa",
  SECURITY_ASSURANCE: "sec",
  DATA_PERF_RELIABILITY_PRIVACY: "dprp",
  EVIDENCE_VERIFICATION_REMEDIATION: "evr",
  KNOWLEDGE_AND_LEARNING: "know",
  AUTOMATION_AND_INFRASTRUCTURE: "auto",
  BUSINESS_DOMAIN_REPORTING: "biz",
};

const agents = [];
for (const guild of GUILDS) {
  for (const [name, riskCeiling, canDetect, skills] of ROLES[guild]) {
    agents.push({
      id: `${guildPrefix[guild]}.${kebab(name)}`,
      name: `${name} Agent`,
      version: "0.1.0",
      guild,
      description: `${name} Agent — canonical ${guild.replace(/_/g, " ").toLowerCase()} role.`,
      capabilities: skills.slice(0, 3),
      skills,
      knowledgeRequirements: [],
      allowedTools: [],
      permissions: {
        canDetect,
        canVerifyOwnFinding: false,
        canCloseOwnFinding: false,
        canSelfAuthorize: false,
        canExpandScope: false,
        canModifyPolicy: false,
        canExportSecret: false,
      },
      riskCeiling,
      evidenceRequired: canDetect,
      certificationRequired: true,
      evaluationProfile: `${guildPrefix[guild]}-default`,
      status: "DRAFT",
    });
  }
}

const registry = { version: "0.1.0", guilds: GUILDS, agents };
mkdirSync(join(ROOT, "agents", "registry"), { recursive: true });
writeFileSync(join(ROOT, "agents", "registry", "agents.json"), JSON.stringify(registry, null, 2) + "\n");
console.log(`Wrote ${agents.length} agent definitions across ${GUILDS.length} guilds.`);
