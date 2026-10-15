import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Threads pool: the heavy spec-30+ engine tests are synchronous CPU work that starves
    // the forks pool's IPC channel, producing intermittent `onTaskUpdate` RPC timeouts
    // (exit 1 with a green suite). Worker threads keep the channel responsive.
    pool: "threads",
  },
});
