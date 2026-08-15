import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/codex-mcp-server.ts", "src/collaboration-message.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  target: "node20",
});
