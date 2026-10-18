import fs from "node:fs";
import path from "node:path";
import { createShadowHeightIndex } from "../src/rendering/shadow-height-index.ts";

const directory = path.resolve(
  process.argv[2] ??
    (process.env.TILE_ROOT
      ? `${process.env.TILE_ROOT}/moon/elevation-tiles`
      : "../tile-service/public/data/moon/elevation-tiles"),
);
const output = path.resolve(process.argv[3] ?? "public/benchmarks/terrain-cache");
const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf8"));
const entries = { ...manifest.tiles };
for (const page of Object.values(manifest.pages ?? {}) as { path: string }[]) {
  const data = JSON.parse(fs.readFileSync(path.join(directory, page.path), "utf8"));
  Object.assign(entries, data.tiles ?? data);
}
const pole = Object.keys(entries)
  .filter((key) => key.startsWith("3/") && entries[key].path)
  .map((key) => ({ key, parts: key.split("/").map(Number) }))
  .filter(({ parts: [, level, x, y] }) => {
    // Direction of Shackleton: cube face -Y.
    const lat = (-89.67 * Math.PI) / 180,
      lon = (129.78 * Math.PI) / 180;
    const dx = Math.cos(lat) * Math.cos(lon),
      dy = Math.sin(lat),
      dz = -Math.cos(lat) * Math.sin(lon);
    const u = (dx / -dy + 1) / 2,
      v = (dz / -dy + 1) / 2,
      n = 2 ** level;
    return Math.floor(u * n) === x && Math.floor(v * n) === y;
  })
  .sort((a, b) => b.parts[1] - a.parts[1])[0];
if (!pole || pole.parts[1] < 1) throw new Error("Downloaded south-polar elevation tiles required");
const keys = Array.from({ length: 6 }, (_, f) => `${f}/0/0/0`);
function ensure(key: string) {
  if (!keys.includes(key)) keys.push(key);
  return keys.indexOf(key) + 1;
}
const cases = ["0/1/0/0", pole.key].map((key) => {
  const [face, level, x, y] = key.split("/").map(Number);
  const parent = `${face}/${level - 1}/${x >> 1}/${y >> 1}`;
  for (let l = 1; l < level; l++) {
    const shift = level - l;
    ensure(`${face}/${l}/${x >> shift}/${y >> shift}`);
  }
  const fineLayer = ensure(key),
    parentLayer = ensure(parent),
    w = manifest.tileSize + manifest.gutter * 2,
    scale = manifest.tileSize / w,
    pad = manifest.gutter / w;
  return {
    key,
    face,
    level,
    x,
    y,
    fineLayer,
    parentLayer,
    faceUV: [x / 2 ** level, y / 2 ** level, 1 / 2 ** level, 1 / 2 ** level],
    bestUV: [pad, pad + scale, scale, -scale],
    parentUV: [pad + ((x % 2) * scale) / 2, pad + (1 - (y % 2) / 2) * scale, scale / 2, -scale / 2],
  };
});
fs.mkdirSync(output, { recursive: true });
const width = manifest.tileSize + 2 * manifest.gutter;
const bytes = Buffer.alloc((keys.length + 1) * width * width * 2);
for (let i = 0; i < bytes.length; i += 2) bytes.writeUInt16LE(20000, i);
keys.forEach((key, index) => {
  const data = fs.readFileSync(path.join(directory, entries[key].path));
  if (data.byteLength !== width * width * 2) throw new Error(`Bad tile byte count: ${key}`);
  data.copy(bytes, (index + 1) * width * width * 2);
});
const index = createShadowHeightIndex(keys.length, manifest.maxLevel);
index.write(
  keys.map((key, i) => {
    const [face, level, x, y] = key.split("/").map(Number);
    return { face, level, x, y, slot: i + 1, start: 0 };
  }),
  1000,
  0,
);
fs.writeFileSync(path.join(output, "heights.bin"), bytes);
fs.writeFileSync(path.join(output, "index.bin"), new Uint8Array(index.data.buffer));
const fixture = {
  version: 1,
  radius: manifest.radiusMeters,
  core: manifest.tileSize,
  gutter: manifest.gutter,
  width,
  layers: keys.length + 1,
  min: manifest.minMeters,
  max: manifest.maxMeters,
  maxLevel: manifest.maxLevel,
  indexWidth: index.texture.image.width,
  indexHeight: index.texture.image.height,
  keys,
  cases,
};
fs.writeFileSync(path.join(output, "fixture.json"), JSON.stringify(fixture, null, 2));
index.dispose();
console.log(JSON.stringify(fixture, null, 2));
