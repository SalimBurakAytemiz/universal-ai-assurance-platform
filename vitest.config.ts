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
