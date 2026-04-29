import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Build the React + CopilotKit app that serves both as:
//  - embedded chat.surface iframe loaded from /v1/clawpilotkit/ui/
//  - standalone consumer at the same URL opened as a top-level page
//
// The entry is app/index.html; built artifacts land in ./ui so the plugin's
// static handler can serve them from a stable PLUGIN_ROOT/ui directory.

export default defineConfig({
  plugins: [react()],
  root: resolve(import.meta.dirname, "app"),
  // The gateway serves assets from /v1/clawpilotkit/ui/ — asset URLs in the
  // built index.html need to be absolute under that prefix.
  base: "/v1/clawpilotkit/ui/",
  build: {
    outDir: resolve(import.meta.dirname, "ui"),
    emptyOutDir: true,
    sourcemap: false,
    // CopilotKit v2 react-ui pulls in Shiki (200+ language grammars) and
    // Mermaid, which alone inflates the bundle past the point where Rollup's
    // chunk-rendering pass fits in ~2 GiB of free RAM. Skip minification and
    // split the heaviest vendor deps into their own top-level chunks so
    // rendering has less per-chunk peak memory to hold.
    minify: false,
    assetsDir: "assets",
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      maxParallelFileOps: 1,
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/shiki")) return "shiki";
          if (id.includes("node_modules/mermaid") || id.includes("node_modules/cytoscape")) {
            return "mermaid";
          }
          if (id.includes("node_modules/@copilotkit")) return "copilotkit";
          if (id.includes("node_modules/@ag-ui")) return "agui";
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) {
            return "react";
          }
        },
      },
    },
  },
});
