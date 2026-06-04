import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@open-managed-agents/adapter-core": path.resolve(__dirname, "../../../adapter/packages/core/src/index.ts"),
    },
  },
  test: {
    globals: false,
  },
});
