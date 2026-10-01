import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Tests read shared types from source, so `npm test` works on a fresh clone without a build.
  resolve: {
    alias: {
      "@homegenie/shared": fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url)),
      "@homegenie/parser": fileURLToPath(new URL("./packages/parser/src/index.ts", import.meta.url)),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"], fileParallelism: false, testTimeout: 20000 },
});
