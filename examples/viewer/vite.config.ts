import { resolve } from "node:path";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

const here = import.meta.dirname;
const repository = resolve(here, "../..");

// Tile pyramids are served by the sibling tile-service. Night lights and clouds stay here.
export default defineConfig(({ mode }) => {
  const tileTarget = loadEnv(mode, here, "VITE_").VITE_TILE_BASE ?? "http://127.0.0.1:8787";

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
    // Uses the library's source, so it needs no build first.
    resolve: { alias: { "tiled-globe": resolve(repository, "src/index.ts") } },
    server: { proxy, fs: { allow: [repository] } },
    preview: { proxy },
  };
});
