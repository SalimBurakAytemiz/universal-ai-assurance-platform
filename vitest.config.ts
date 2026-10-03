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
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["packages/**/test/**/*.test.ts", "tests/**/*.test.ts"],
    reporters: ["default"],
    coverage: {
      enabled: false,
    },
  },
});
