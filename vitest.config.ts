import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Vitest 4 pool: `threads` was removed upstream; `forks` (tinyexec-based) is the
    // supported stable pool. The tinypool-era RPC timeouts this config once avoided
    // are obsolete — the engine was rewritten. Re-evaluate only if the flake returns.
    pool: "forks",
  },
});
