import { DataTexture, FloatType, RGBAFormat, NearestFilter, NoColorSpace } from "three/webgpu";
import { fadeWeight } from "../tiles/resident-tiles.ts";

export type ShadowHeightRecord = {
  face: number;
  level: number;
  x: number;
  y: number;
  slot: number;
  fadeStart?: number;
};
// Sparse quadtree: one RGBA texel of children, one of (slot, fade, 0, 0).
// Six roots stay addressable even while some source tiles are still loading.
export function createShadowHeightIndex(residentLimit: number, maxLevel: number) {
  const capacity = 6 + residentLimit * (maxLevel + 1);
  const width = 256,
    height = Math.ceil((capacity * 2) / width);
  const data = new Float32Array(width * height * 4);
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.name = "Resident elevation quadtree for sunlight";
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.colorSpace = NoColorSpace;
  texture.generateMipmaps = false;
  const previous = new Float32Array(data.length).fill(NaN);
  let revision = 0;
  let nodes = 6;
  function write(records: Iterable<ShadowHeightRecord>, now: number, fadeMs: number) {
    data.fill(0);
    for (let i = 0; i < capacity; i++) data.fill(-1, i * 8, i * 8 + 4);
    nodes = 6;
    for (const record of records) {
      let node = record.face;
      for (let level = 1; level <= record.level; level++) {
        const shift = record.level - level,
          quadrant = ((record.x >> shift) & 1) + 2 * ((record.y >> shift) & 1),
          offset = node * 8 + quadrant;
        let child = data[offset];
        if (child < 0) {
          if (nodes >= capacity) throw new RangeError("Shadow height index capacity exceeded");
          child = nodes++;
          data[offset] = child;
        }
        node = child;
      }
      data[node * 8 + 4] = record.slot;
      data[node * 8 + 5] = fadeWeight(record.fadeStart, now, fadeMs);
    }
    if (data.some((value, i) => value !== previous[i])) {
      previous.set(data);
      revision++;
      texture.needsUpdate = true;
    }
  }
  write([], 0, 0);
  return {
    texture,
    data,
    write,
    get revision() {
      return revision;
    },
    nodeCount: () => nodes,
    dispose: () => texture.dispose(),
  };
}
