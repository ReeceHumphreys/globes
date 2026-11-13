import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";

const here = import.meta.dirname;
const repository = resolve(here, "../..");

// Globe data comes from the sibling tile-service; the tileset is in public/.
export default defineConfig(({ mode }) => {
  const target = loadEnv(mode, here, "VITE_").VITE_TILE_BASE ?? "http://127.0.0.1:8787";
  return {
    resolve: { alias: { "tiled-globe": resolve(repository, "src/index.ts") } },
    server: { proxy: { "/data": { target, changeOrigin: true } }, fs: { allow: [repository] } },
  };
});
