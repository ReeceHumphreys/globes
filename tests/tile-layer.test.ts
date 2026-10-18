import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { Scene, DataArrayTexture } from "three/webgpu";
import { createTileBatch } from "../src/tiles/tile.ts";
import { createTileInstances, writeTileInstances } from "../src/rendering/tile-instances.ts";
import { selectTiles } from "../src/tiles/quadtree.ts";

// Vite loads the real ?raw WGSL imports, just as in the application. Run the
// resulting module in Node to inspect resources and instance data without a GPU.
const bundle = await build({
  configFile: false,
  logLevel: "silent",
  ssr: { noExternal: ["pmtiles", "fflate"] },
  build: {
    ssr: fileURLToPath(new URL("../src/rendering/tile-layer.ts", import.meta.url)),
    write: false,
    minify: false,
  },
});
const entry = bundle.output.find((chunk) => chunk.type === "chunk" && chunk.isEntry);
// A data: module needs absolute URLs for its external Three.js imports.
const code = entry.code.replace(
  /from (["'])(three(?:\/[^"']*)?)\1/g,
  (_, quote, specifier) => `from ${JSON.stringify(import.meta.resolve(specifier))}`,
);
const { createTileLayer } = await import(
  `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
);

test("one grid and material bind the producer arrays across zoom levels", () => {
  const radius = 1_737_400;
  const tiles = createTileBatch(384);
  let instances = createTileInstances(384);
  const layer = createTileLayer(radius, 32, instances);
  const scene = new Scene();
  scene.add(layer.group);
  const mesh = layer.group.children[0];
  const geometry = mesh.geometry;
  const material = mesh.material;
  const buffers = [
    "tileSize",
    "tileRotation",
    "tileCenter",
    "tileColor",
    "tileAnchor",
    "tileFaceUV",
  ].map((name) => geometry.getAttribute(name));

  // Count underlying buffers, not attributes: WebGPU guarantees only eight.
  const vertexBuffers = new Set(
    Object.values(geometry.attributes).map((a) => (a.isInterleavedBufferAttribute ? a.data : a)),
  );
  assert.equal(vertexBuffers.size, 8);
  assert.equal(geometry.getAttribute("position").data, geometry.getAttribute("uv").data);
  assert.equal(
    geometry.getAttribute("imageryLayers").data,
    geometry.getAttribute("imageryUV").data,
  );
  assert.equal(geometry.instanceCount, 0);
  assert.equal(mesh.visible, false);
  assert.equal(geometry.getAttribute("position").count, 33 * 33 + 4 * 32);
  assert.equal(geometry.boundingSphere.radius, radius);

  for (const level of [0, 1, 2, 3, 2, 1, 0]) {
    selectTiles(tiles, level);
    writeTileInstances(tiles, instances, radius);
    const versions = buffers.map((buffer) => buffer.version);
    layer.commit(instances);
    assert.equal(layer.group.children.length, 1);
    assert.equal(layer.group.children[0], mesh);
    assert.equal(mesh.geometry, geometry);
    assert.equal(mesh.material, material);
    assert.equal(geometry.instanceCount, tiles.count);
    assert.equal(mesh.visible, true);
    buffers.forEach((buffer, i) => {
      assert.equal(buffer.isInstancedBufferAttribute, true);
      assert.equal(buffer.meshPerAttribute, 1);
      assert.equal(buffer.version, versions[i] + 1);
      assert.deepEqual(buffer.updateRanges, [{ start: 0, count: tiles.count * buffer.itemSize }]);
    });
    // Renderer borrows the producer's views directly; there is no packing copy.
    [
      instances.sizes,
      instances.rotations,
      instances.centers,
      instances.colors,
      instances.anchors,
      instances.faceUVs,
    ].forEach((array, i) => assert.equal(buffers[i].array, array));
  }

  const snapshot = buffers.map((buffer) => buffer.array.slice());
  const badCount = { ...instances, count: 385 };
  assert.throws(() => layer.commit(badCount), /Invalid/);
  assert.equal(geometry.instanceCount, 6);
  buffers.forEach((buffer, i) => assert.deepEqual(buffer.array, snapshot[i]));

  instances.count = 0;
  layer.commit(instances);
  assert.equal(mesh.visible, false);
  assert.equal(geometry.instanceCount, 0);

  let geometryDisposals = 0;
  let materialDisposals = 0;
  geometry.addEventListener("dispose", () => geometryDisposals++);
  material.addEventListener("dispose", () => materialDisposals++);
  layer.dispose();
  layer.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(layer.group.parent, null);
  assert.equal(layer.group.children.length, 0);
});

test("elevation can arrive after first render without recreating geometry or leaking textures", () => {
  const layer = createTileLayer(1737400, 32, createTileInstances(6));
  const mesh = layer.group.children[0],
    geometry = mesh.geometry,
    material = mesh.material;
  let elevationNode;
  material.positionNode.traverse((node) => {
    if (node.isTextureNode && node.value.name === "Global terrain heights (numeric RG8)")
      elevationNode = node;
  });
  assert.ok(elevationNode);
  const placeholder = elevationNode.value;
  let placeholderDisposals = 0,
    loadedDisposals = 0;
  placeholder.addEventListener("dispose", () => placeholderDisposals++);
  const version = material.version;
  layer.setElevation({
    width: 2,
    height: 2,
    values: new Uint16Array(4).fill(22000),
    minMeters: 1000,
    maxMeters: 1000,
  });
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.ok(material.version > version);
  assert.equal(placeholderDisposals, 1);
  assert.notEqual(elevationNode.value, placeholder);
  assert.equal(elevationNode.value.image.width, 2);
  elevationNode.value.addEventListener("dispose", () => loadedDisposals++);
  layer.setElevationEnabled(false);
  layer.setElevationEnabled(true);
  layer.dispose();
  layer.dispose();
  assert.equal(loadedDisposals, 1);
});

test("tiled elevation uses the existing instance buffer and keeps eight bindings / sixteen attributes", () => {
  const instances = createTileInstances(6),
    layer = createTileLayer(1737400, 32, instances),
    geometry = layer.group.children[0].geometry;
  try {
    const attributes = Object.values(geometry.attributes),
      buffers = new Set(attributes.map((a) => (a.isInterleavedBufferAttribute ? a.data : a)));
    assert.equal(buffers.size, 8);
    assert.equal(attributes.length, 16);
    assert.equal(
      geometry.getAttribute("heightLayers").data,
      geometry.getAttribute("imageryLayers").data,
    );
    assert.equal(geometry.getAttribute("heightLayers").data.stride, 25);
  } finally {
    layer.dispose();
  }
});

test("imagery-only consumers do not require a Moon overview texture", () => {
  const texture = new DataArrayTexture(new Uint8Array(4), 1, 1, 1);
  const cache = { texture, bindings: { data: new Float32Array(6 * 11), revision: 0 } };
  const layer = createTileLayer(3389500, 32, createTileInstances(6), undefined, cache);
  const parameters = layer.group.children[0].material.colorNode.parameters;
  layer.setSurfaceLayer("imagery");
  assert.equal(parameters.imageryEnabled.value, 1);
  assert.equal(parameters.tiledImageryEnabled.value, 1);
  layer.setSurfaceLayer("checker");
  assert.equal(parameters.imageryEnabled.value, 0);
  layer.setSurfaceLayer("imagery");
  assert.equal(parameters.imageryEnabled.value, 1);
  layer.dispose();
  texture.dispose();
});
