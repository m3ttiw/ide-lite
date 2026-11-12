import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic in src/lib: no DOM, no Solid plugin.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
