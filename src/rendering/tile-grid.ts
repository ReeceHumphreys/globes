import {
  PlaneGeometry,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
} from "three/webgpu";

// Shared surface grid plus duplicate perimeter vertices lowered by WGSL.
// position.z is a skirt flag, not a physical coordinate.
export function createTileGrid(segments: number): BufferGeometry {
  const plane = new PlaneGeometry(1, 1, segments, segments);
  const surface = plane.getAttribute("position");
  const perimeter: number[] = [];
  const row = segments + 1;
  for (let x = 0; x < segments; x++) perimeter.push(x);
  for (let y = 0; y < segments; y++) perimeter.push(y * row + segments);
  for (let x = segments; x > 0; x--) perimeter.push(segments * row + x);
  for (let y = segments; y > 0; y--) perimeter.push(y * row);
  const positions = new Float32Array((surface.count + perimeter.length) * 3);
  positions.set(surface.array);
  const indices = Array.from(plane.index!.array);
  for (let j = 0; j < perimeter.length; j++) {
    const a = perimeter[j],
      b = perimeter[(j + 1) % perimeter.length];
    const loA = surface.count + j,
      loB = surface.count + ((j + 1) % perimeter.length);
    positions[loA * 3] = surface.getX(a);
    positions[loA * 3 + 1] = surface.getY(a);
    positions[loA * 3 + 2] = 1;
    indices.push(a, b, loA, b, loB, loA);
  }
  const grid = new BufferGeometry();
  // Position and UV share one vertex buffer (WebGPU guarantees only eight).
  const vertices = new Float32Array((surface.count + perimeter.length) * 5);
  for (let i = 0; i < vertices.length / 5; i++) {
    vertices[i * 5] = positions[i * 3];
    vertices[i * 5 + 1] = positions[i * 3 + 1];
    vertices[i * 5 + 2] = positions[i * 3 + 2];
    vertices[i * 5 + 3] = positions[i * 3] + 0.5;
    vertices[i * 5 + 4] = positions[i * 3 + 1] + 0.5;
  }
  const vertexBuffer = new InterleavedBuffer(vertices, 5);
  grid.setAttribute("position", new InterleavedBufferAttribute(vertexBuffer, 3, 0));
  grid.setAttribute("uv", new InterleavedBufferAttribute(vertexBuffer, 2, 3));
  grid.setIndex(indices);
  plane.dispose();
  return grid;
}
