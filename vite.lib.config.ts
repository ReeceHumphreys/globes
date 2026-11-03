import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/library",
    lib: {
      entry: { index: "src/index.ts" },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rolldownOptions: { external: [/^three(?:\/|$)/, "pmtiles"] },
    sourcemap: true,
  },
});
