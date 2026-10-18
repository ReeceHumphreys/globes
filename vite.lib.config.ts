import { defineConfig } from "vite";

export default defineConfig({
  publicDir: false,
  build: {
    outDir: "dist/library",
    lib: { entry: "src/index.ts", formats: ["es"], fileName: () => "index.js" },
    rolldownOptions: { external: [/^three(?:\/|$)/, "satellite.js", "pmtiles"] },
    sourcemap: true,
  },
});
