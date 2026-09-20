import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: [new URL("./test/setup.ts", import.meta.url).pathname],
    testTimeout: 15000,
    include: ["test/**/*.test.ts"],
  },
});
