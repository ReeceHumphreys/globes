import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

// The United States' outline without its land borders: an edge shared with another
// country is a border, and every other edge is coast.
const source =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_10m_admin_0_countries.geojson";
async function download() {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Countries: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
const bytes = process.argv[2] ? await readFile(process.argv[2]) : await download();
if (
  createHash("sha256").update(bytes).digest("hex") !==
  "239eec57ac17f100a11e2536cffc56752c318b50ae765b0918ff7aab4ce8f255"
)
  throw new Error("Countries source does not match the pinned Natural Earth release");

type Point = [number, number];
interface Country {
  properties: { ADM0_A3: string };
  geometry: { type: string; coordinates: Point[][] | Point[][][] };
}
const countries: Country[] = JSON.parse(new TextDecoder().decode(bytes)).features;
const rings = ({ geometry }: Country) =>
  (geometry.type === "Polygon"
    ? [geometry.coordinates as Point[][]]
    : (geometry.coordinates as Point[][][])
  ).flat();
const edge = (a: Point, b: Point) => [a.join(), b.join()].sort().join(" ");

const borders = new Set<string>();
for (const country of countries)
  if (country.properties.ADM0_A3 !== "USA")
    for (const ring of rings(country))
      for (let i = 1; i < ring.length; i++) borders.add(edge(ring[i - 1], ring[i]));

const lines: Point[][] = [];
let dropped = 0;
for (const country of countries.filter((c) => c.properties.ADM0_A3 === "USA"))
  for (const ring of rings(country)) {
    let line: Point[] = [];
    const finish = () => {
      if (line.length > 1) lines.push(line);
      line = [];
    };
    for (let i = 1; i < ring.length; i++) {
      const a = ring[i - 1],
        b = ring[i];
      // The Aleutians are cut at the antimeridian, which is not a shore.
      const cut = Math.abs(a[0]) === 180 && Math.abs(b[0]) === 180;
      if (cut || borders.has(edge(a, b))) {
        dropped++;
        finish();
        continue;
      }
      if (line.length === 0) line.push(a);
      line.push(b);
    }
    finish();
  }

const rounded = lines.map((line) =>
  line.map(([x, y]) => [Number(x.toFixed(4)), Number(y.toFixed(4))]),
);
const directory = new URL("../assets/coastlines/", import.meta.url);
await mkdir(directory, { recursive: true });
const output = JSON.stringify({
  type: "Feature",
  properties: { name: "United States coastline" },
  geometry: { type: "MultiLineString", coordinates: rounded },
});
await writeFile(new URL("usa.geojson", directory), output);
console.log(
  `${lines.length} lines, ${rounded.flat().length} points, ${dropped} border edges dropped, ${output.length} bytes`,
);
