import { resolve } from "node:path";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

// Tile pyramids are served by the sibling tile-service. Night lights and clouds stay here.
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
      /^\/data\/earth\/(night-lights|clouds)\//.test(req.url ?? "") ? req.url : undefined,
    ),
  };

  return {
    resolve: {
      alias:
        command === "serve"
          ? [{ find: /^tiled-globe$/, replacement: resolve("src/index.ts") }]
          : [],
    },
    build: {
      outDir: "dist/demo",
    },
    server: { proxy },
    preview: { proxy },
  };
});
