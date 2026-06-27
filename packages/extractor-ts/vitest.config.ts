import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node"
  },
  resolve: {
    alias: {
      "@snitch/graph": new URL("../graph/src/index.ts", import.meta.url).pathname
    }
  }
});
