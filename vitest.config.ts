import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    silent: "passed-only",
    name: "bb-plugin-polza",
    include: ["src/**/*.test.ts", "*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
