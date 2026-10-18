import { resolve } from "node:path";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { takramCompatibility } from "./examples/planets/takram-compat-plugin.ts";

// Tile pyramids are served by the sibling tile-service. Night lights stay here.
export default defineConfig(({ command, mode }) => {
  const tileTarget =
    loadEnv(mode, process.cwd(), "VITE_").VITE_TILE_BASE ?? "http://127.0.0.1:8787";

  function tileProxy(bypass?: ProxyOptions["bypass"]): ProxyOptions {
    return { target: tileTarget, changeOrigin: true, bypass };
  }

  const proxy = {
    "/data/moon": tileProxy(),
    "/data/mars": tileProxy(),
    "/data/earth": tileProxy((req) =>
      req.url?.startsWith("/data/earth/night-lights") ? req.url : undefined,
    ),
  };

  return {
    resolve: {
      alias:
        command === "serve" ? [{ find: "tiled-globe", replacement: resolve("src/index.ts") }] : [],
    },
    build: {
      outDir: "dist/demo",
    },
    server: { proxy },
    preview: { proxy },
    // satellite.js ships optional WASM worker runtimes that use top-level await.
    worker: { format: "es" },
    optimizeDeps: {
      // Takram remains unbundled for the compatibility transform, but its bare
      // Three imports must join the same optimized core as our WebGPU imports.
      include: ["three", "three/webgpu", "three/tsl", "three/src/nodes/core/NodeUtils.js"],
      exclude: ["@takram/three-atmosphere", "@takram/three-geospatial"],
    },
    plugins: [takramCompatibility()],
  };
});
