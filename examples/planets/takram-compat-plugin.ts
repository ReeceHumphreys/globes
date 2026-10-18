import { resolve } from "node:path";
import type { Plugin } from "vite";

/** Scope the pinned experimental dependency's API adapter to its own TSL imports. */
export function takramCompatibility(): Plugin {
  return {
    name: "takram-three-r186-struct-compatibility",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "three/tsl" &&
        importer?.replaceAll("\\", "/").includes("/node_modules/@takram/")
      )
        return resolve("examples/planets/takram-tsl-compat.ts");
    },
    transform(code, id) {
      if (!id.replaceAll("\\", "/").includes("/node_modules/@takram/three-geospatial/")) return;
      const remoteNoise =
        /`https:\/\/media\.githubusercontent\.com\/media\/takram-design-engineering\/three-geospatial\/\$\{[^}]+\}\/packages\/core\/assets\/stbn\.bin`/g;
      if (!remoteNoise.test(code)) return;
      return {
        code:
          `import __globesSTBNURL from ${JSON.stringify(resolve("examples/planets/assets/stbn.bin") + "?url")};\n` +
          code.replace(remoteNoise, "__globesSTBNURL"),
        map: null,
      };
    },
  };
}
