import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@uaap/core": r("./packages/core/src/index.ts"),
      "@uaap/authorization-kernel": r("./packages/authorization-kernel/src/index.ts"),
      "@uaap/policy-engine": r("./packages/policy-engine/src/index.ts"),
      "@uaap/audit": r("./packages/audit/src/index.ts"),
      "@uaap/tool-broker": r("./packages/tool-broker/src/index.ts"),
      "@uaap/orchestrator": r("./packages/orchestrator/src/index.ts"),
      "@uaap/agent-events": r("./packages/agent-events/src/index.ts"),
      "@uaap/agent-permissions": r("./packages/agent-permissions/src/index.ts"),
      "@uaap/tool-adapter-registry": r("./packages/tool-adapter-registry/src/index.ts"),
      "@uaap/project-model": r("./packages/project-model/src/index.ts"),
      "@uaap/digital-twin": r("./packages/digital-twin/src/index.ts"),
      "@uaap/evidence-engine": r("./packages/evidence-engine/src/index.ts"),
      "@uaap/verification-engine": r("./packages/verification-engine/src/index.ts"),
      "@uaap/release-gate": r("./packages/release-gate/src/index.ts"),
      "@uaap/remediation-engine": r("./packages/remediation-engine/src/index.ts"),
      "@uaap/knowledge": r("./packages/knowledge/src/index.ts"),
      "@uaap/agent-evaluation": r("./packages/agent-evaluation/src/index.ts"),
      "@uaap/domain-model": r("./packages/domain-model/src/index.ts"),
      "@uaap/assurance-planner": r("./packages/assurance-planner/src/index.ts"),
      "@uaap/knowledge-graph": r("./packages/knowledge-graph/src/index.ts"),
      "@uaap/engine-core": r("./packages/engine-core/src/index.ts"),
      "@uaap/quality-api-engine": r("./packages/quality-api-engine/src/index.ts"),
      "@uaap/quality-database-engine": r("./packages/quality-database-engine/src/index.ts"),
      "@uaap/quality-realtime-engine": r("./packages/quality-realtime-engine/src/index.ts"),
      "@uaap/quality-performance-engine": r("./packages/quality-performance-engine/src/index.ts"),
      "@uaap/quality-accessibility-engine": r("./packages/quality-accessibility-engine/src/index.ts"),
      "@uaap/security-appsec-engine": r("./packages/security-appsec-engine/src/index.ts"),
      "@uaap/research-intelligence": r("./packages/research-intelligence/src/index.ts"),
      "@uaap/desktop-viewmodels": r("./packages/desktop-viewmodels/src/index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "tests/**/*.test.ts", "services/**/test/**/*.test.mjs"],
    reporters: ["default"],
    coverage: {
      enabled: false,
    },
  },
});
