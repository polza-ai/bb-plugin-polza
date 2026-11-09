import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    silent: "passed-only",
    name: "bb-plugin-polza",
    include: ["src/**/*.test.ts", "*.test.ts", "*.test.tsx"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
