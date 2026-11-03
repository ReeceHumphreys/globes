import { readFile, writeFile, mkdir } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const source =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_ocean.geojson";
const bytes = process.argv[2]
  ? await readFile(process.argv[2])
  : new Uint8Array(
      await await fetch(source).then((r) => {
        if (!r.ok) throw new Error(`Ocean polygons: HTTP ${r.status}`);
        return r.arrayBuffer();
      }),
    );
const collection = JSON.parse(new TextDecoder().decode(bytes));
const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
if (sourceSha256 !== "5b810162af4b20805838cfd766ef1a445c350cf6aafc8b589515daef30033adf")
  throw new Error("Ocean polygon source does not match the pinned Natural Earth release");
const width = 4096,
  height = 2048;
const pixels = new Uint8Array(width * height);
type Ring = [number, number][];
// Scan at pixel centers with an even/odd fill, including islands (polygon holes).
for (const feature of collection.features) {
  const geometry = feature.geometry;
  const polygons: Ring[][] =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  for (const rings of polygons) {
    const edges = rings.flatMap((ring) => ring.slice(1).map((point, i) => [ring[i], point]));
    for (let y = 0; y < height; y++) {
      const latitude = 90 - ((y + 0.5) / height) * 180;
      const intersections: number[] = [];
      for (const [a, b] of edges) {
        if (a[1] > latitude === b[1] > latitude) continue;
        const longitude = a[0] + ((latitude - a[1]) / (b[1] - a[1])) * (b[0] - a[0]);
        intersections.push(((longitude + 180) / 360) * width - 0.5);
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2) {
        const start = Math.max(0, Math.ceil(intersections[i]));
        const end = Math.min(width, Math.ceil(intersections[i + 1]));
        pixels.fill(255, y * width + start, y * width + end);
      }
    }
  }
}
const directory = new URL("../examples/viewer/assets/ocean/", import.meta.url);
await mkdir(directory, { recursive: true });
const packed = gzipSync(pixels, { level: 9 });
await writeFile(new URL("water-mask.bin.gz", directory), packed);
await writeFile(
  new URL("manifest.json", directory),
  JSON.stringify(
    {
      source,
      credit: "Made with Natural Earth",
      license: "Public domain",
      width,
      height,
      format: "R8, 255 ocean, 0 land, north-to-south rows, -180 to +180 longitude",
      sourceSha256,
      sha256: createHash("sha256").update(pixels).digest("hex"),
      bytes: pixels.length,
      compressedBytes: packed.length,
    },
    null,
    2,
  ) + "\n",
);
console.info(`Ocean mask: ${width}×${height}, ${packed.length} compressed bytes`);
