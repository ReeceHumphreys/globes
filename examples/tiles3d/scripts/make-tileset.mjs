// Writes a one-tile 3D Tiles 1.1 tileset: a box standing at a WGS84 point.
// Usage: node make-tileset.mjs <out dir> <lat> <lon> <height m> <east m> <north m> <tall m>
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [out, lat, lon, h, east, north, tall] = process.argv.slice(2);
const [phi, lambda] = [Number(lat), Number(lon)].map((d) => (d * Math.PI) / 180);
const a = 6378137,
  f = 1 / 298.257223563,
  e2 = f * (2 - f);
const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
const center = [
  (n + +h) * Math.cos(phi) * Math.cos(lambda),
  (n + +h) * Math.cos(phi) * Math.sin(lambda),
  (n * (1 - e2) + +h) * Math.sin(phi),
];
const E = [-Math.sin(lambda), Math.cos(lambda), 0];
const N = [-Math.sin(phi) * Math.cos(lambda), -Math.sin(phi) * Math.sin(lambda), Math.cos(phi)];
const U = [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
// Column-major east-north-up frame at the base of the box.
const transform = [...E, 0, ...N, 0, ...U, 0, ...center, 1];

// A box in glTF's y-up frame: x east, y up, z south, base at y = 0.
const [w, d, t] = [east / 2, north / 2, +tall];
const faces = [
  [
    [1, 0, 0],
    [
      [w, 0, -d],
      [w, t, -d],
      [w, t, d],
      [w, 0, d],
    ],
  ],
  [
    [-1, 0, 0],
    [
      [-w, 0, d],
      [-w, t, d],
      [-w, t, -d],
      [-w, 0, -d],
    ],
  ],
  [
    [0, 1, 0],
    [
      [-w, t, -d],
      [-w, t, d],
      [w, t, d],
      [w, t, -d],
    ],
  ],
  [
    [0, -1, 0],
    [
      [-w, 0, d],
      [-w, 0, -d],
      [w, 0, -d],
      [w, 0, d],
    ],
  ],
  [
    [0, 0, 1],
    [
      [w, 0, d],
      [w, t, d],
      [-w, t, d],
      [-w, 0, d],
    ],
  ],
  [
    [0, 0, -1],
    [
      [-w, 0, -d],
      [-w, t, -d],
      [w, t, -d],
      [w, 0, -d],
    ],
  ],
];
const positions = [],
  normals = [],
  indices = [];
faces.forEach(([normal, corners], i) => {
  for (const c of corners) (positions.push(...c), normals.push(...normal));
  const k = i * 4;
  indices.push(k, k + 1, k + 2, k, k + 2, k + 3);
});
const pos = new Float32Array(positions),
  nor = new Float32Array(normals),
  idx = new Uint16Array(indices);
const bin = Buffer.concat([
  Buffer.from(pos.buffer),
  Buffer.from(nor.buffer),
  Buffer.from(idx.buffer),
  Buffer.alloc((4 - (idx.byteLength % 4)) % 4),
]);
const gltf = {
  asset: { version: "2.0" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [
    {
      pbrMetallicRoughness: {
        baseColorFactor: [0.85, 0.3, 0.2, 1],
        metallicFactor: 0,
        roughnessFactor: 0.8,
      },
    },
  ],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
    { buffer: 0, byteOffset: pos.byteLength, byteLength: nor.byteLength, target: 34962 },
    { buffer: 0, byteOffset: pos.byteLength * 2, byteLength: idx.byteLength, target: 34963 },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: pos.length / 3,
      type: "VEC3",
      min: [-w, 0, -d],
      max: [w, t, d],
    },
    { bufferView: 1, componentType: 5126, count: nor.length / 3, type: "VEC3" },
    { bufferView: 2, componentType: 5123, count: idx.length, type: "SCALAR" },
  ],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const glb = Buffer.alloc(12 + 8 + json.length + 8 + bin.length);
glb.writeUInt32LE(0x46546c67, 0);
glb.writeUInt32LE(2, 4);
glb.writeUInt32LE(glb.length, 8);
glb.writeUInt32LE(json.length, 12);
glb.writeUInt32LE(0x4e4f534a, 16);
json.copy(glb, 20);
glb.writeUInt32LE(bin.length, 20 + json.length);
glb.writeUInt32LE(0x004e4942, 24 + json.length);
bin.copy(glb, 28 + json.length);

const radius = Math.hypot(w, d, t);
const tileset = {
  asset: { version: "1.1" },
  geometricError: 100,
  root: {
    transform,
    // In the tile's own frame, z-up: glTF content is turned y-up to z-up on load.
    boundingVolume: { sphere: [0, 0, t / 2, radius] },
    geometricError: 0,
    refine: "REPLACE",
    content: { uri: "box.glb" },
  },
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "box.glb"), glb);
writeFileSync(join(out, "tileset.json"), JSON.stringify(tileset, null, 2));
console.log(`Wrote ${out}: box ${east}×${north}×${tall} m at ${lat}, ${lon}, ${h} m`);
