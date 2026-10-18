import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  context as nodeContext,
  highpModelNormalViewMatrix,
  highpModelViewMatrix,
  mix,
  positionGeometry,
} from "three/tsl";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";

export interface RibbonOptions {
  name: string;
  /** CSS color, written as display (sRGB) values by the overlay pass. */
  color: string;
  /** Width in CSS pixels, including the antialiased edge. */
  width: number;
  opacity: number;
  /** Body radius uniform for sightline occlusion, scaled by `occluderScale`. */
  occluderRadius: THREE.Node<"float">;
  /** Below 1 for curves drawn on the surface itself, such as ground tracks. */
  occluderScale?: number;
  /** Maximum segments per frame. */
  capacity: number;
}

/** Fills `out` with the curve point (scene meters) at parameter `p`; false when unavailable. */
export type CurveSample = (p: number, out: Float64Array) => boolean;

const MAX_DEPTH = 18;

function ribbonMaterial(
  color: string,
  width: number,
  opacity: number,
  occluder: RibbonOptions["occluderRadius"],
  scale: number,
) {
  const material = new THREE.Line2NodeMaterial({
    color,
    linewidth: width,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  // The overlay writes display values directly, so keep the CSS color unconverted.
  material.color.setStyle(color, THREE.LinearSRGBColorSpace);
  // positionGeometry.y runs 0→1 from segment start to end; x is ±1 at the ribbon's sides.
  const along = positionGeometry.y.clamp(0, 1);
  const edge = positionGeometry.x
    .abs()
    .oneMinus()
    .mul(width / 2)
    .clamp(0, 1);
  material.opacityNode = mix(
    attribute<"float">("instanceFadeStart", "float"),
    attribute<"float">("instanceFadeEnd", "float"),
    along,
  ).mul(edge.mul(opacity));
  // Vertices are camera-relative (see draw). With the model-view matrix computed on the CPU
  // in float64, ribbons stay steady even a few meters from a spacecraft; absolute float32
  // coordinates at orbital radii are only good to about half a meter.
  material.contextNode = nodeContext({
    modelViewMatrix: highpModelViewMatrix,
    modelNormalViewMatrix: highpModelNormalViewMatrix,
  });
  // The overlay has no scene depth, so hide fragments whose sightline crosses the body.
  // A camera-relative vertex is already the ray from the camera.
  const ray = mix(
    attribute<"vec3">("instanceStart", "vec3"),
    attribute<"vec3">("instanceEnd", "vec3"),
    along,
  );
  const closest = cameraPosition.add(
    ray.mul(cameraPosition.dot(ray).negate().div(ray.dot(ray)).clamp(0, 1)),
  );
  const radius = occluder.mul(scale);
  material.maskNode = closest.dot(closest).greaterThanEqual(radius.mul(radius));
  return material;
}

/**
 * An antialiased overlay polyline with a dark halo. Each frame, `draw` samples a parametric
 * curve, splitting chords that would visibly cut the curve as seen from the camera, and
 * writes camera-relative vertices.
 */
export function createRibbon(options: RibbonOptions) {
  const { capacity } = options;
  const segments = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * 6), 6, 1);
  const fades = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * 2), 2, 1);
  segments.setUsage(THREE.DynamicDrawUsage);
  fades.setUsage(THREE.DynamicDrawUsage);
  const scale = options.occluderScale ?? 1;
  const material = ribbonMaterial(
    options.color,
    options.width,
    options.opacity,
    options.occluderRadius,
    scale,
  );
  // A soft dark halo keeps light lines legible over clouds and ice.
  const haloMaterial = ribbonMaterial(
    "#000",
    options.width + 3,
    options.opacity * 0.35,
    options.occluderRadius,
    scale,
  );
  const line = new LineSegments2(undefined, material);
  const { geometry } = line;
  geometry.setAttribute("instanceStart", new THREE.InterleavedBufferAttribute(segments, 3, 0));
  geometry.setAttribute("instanceEnd", new THREE.InterleavedBufferAttribute(segments, 3, 3));
  geometry.setAttribute("instanceFadeStart", new THREE.InterleavedBufferAttribute(fades, 1, 0));
  geometry.setAttribute("instanceFadeEnd", new THREE.InterleavedBufferAttribute(fades, 1, 1));
  geometry.instanceCount = 0;
  line.name = options.name;
  line.frustumCulled = false;
  const halo = new LineSegments2(geometry, haloMaterial);
  halo.frustumCulled = false;
  halo.renderOrder = -1;
  line.add(halo);

  const segmentArray = segments.array as Float32Array,
    fadeArray = fades.array as Float32Array;
  let written = 0,
    extent = 0,
    previousAlpha = 0,
    previousParam = 0;
  const previous = new Float64Array(3);
  // One midpoint slot per recursion depth.
  const scratch = Array.from({ length: MAX_DEPTH + 2 }, () => new Float64Array(3));
  const coarseA = new Float64Array(3),
    coarseB = new Float64Array(3);

  return {
    object: line,
    /** Largest distance from the body center among the last frame's vertices. */
    get extent() {
      return extent;
    },
    get segmentCount() {
      return written;
    },
    /**
     * Draw the curve through the coarse parameters `params[0..count)`, in order. `alpha`
     * gives per-vertex opacity. `tolerance` is the largest visible chord sag, in radians
     * seen from `origin` (the camera). Returns false when no segment could be drawn.
     */
    draw(
      origin: THREE.Vector3,
      params: ArrayLike<number>,
      count: number,
      sample: CurveSample,
      alpha: (p: number) => number,
      tolerance: number,
    ): boolean {
      written = 0;
      extent = 0;
      const ox = origin.x,
        oy = origin.y,
        oz = origin.z;
      const push = (p: number, point: Float64Array) => {
        const j = written * 6,
          a = alpha(p);
        segmentArray[j] = previous[0] - ox;
        segmentArray[j + 1] = previous[1] - oy;
        segmentArray[j + 2] = previous[2] - oz;
        segmentArray[j + 3] = point[0] - ox;
        segmentArray[j + 4] = point[1] - oy;
        segmentArray[j + 5] = point[2] - oz;
        fadeArray[written * 2] = previousAlpha;
        fadeArray[written * 2 + 1] = a;
        written++;
        previous.set(point);
        previousAlpha = a;
        previousParam = p;
        extent = Math.max(extent, Math.hypot(point[0], point[1], point[2]));
      };
      // Split [pa, pb] at its parameter midpoint while the chord visibly cuts the curve.
      const refine = (
        pa: number,
        a: Float64Array,
        pb: number,
        b: Float64Array,
        depth: number,
        reserved: number,
      ) => {
        if (depth < MAX_DEPTH && written + reserved + 2 <= capacity) {
          const pm = (pa + pb) / 2,
            m = scratch[depth];
          if (sample(pm, m)) {
            const ax = a[0] - ox,
              ay = a[1] - oy,
              az = a[2] - oz;
            const dx = b[0] - a[0],
              dy = b[1] - a[1],
              dz = b[2] - a[2];
            const length2 = dx * dx + dy * dy + dz * dz;
            const u = length2
              ? Math.min(1, Math.max(0, -(ax * dx + ay * dy + az * dz) / length2))
              : 0;
            const distance = Math.hypot(ax + u * dx, ay + u * dy, az + u * dz);
            const sag = Math.hypot(
              m[0] - (a[0] + b[0]) / 2,
              m[1] - (a[1] + b[1]) / 2,
              m[2] - (a[2] + b[2]) / 2,
            );
            if (sag > tolerance * distance) {
              // Deeper levels only use scratch[depth + 1…], so `m` survives the first half.
              refine(pa, a, pm, m, depth + 1, reserved + 1);
              refine(pm, m, pb, b, depth + 1, reserved);
              return;
            }
          }
        }
        push(pb, b);
      };
      if (count < 2 || !sample(params[0], coarseA)) {
        line.visible = false;
        return false;
      }
      previous.set(coarseA);
      previousAlpha = alpha(params[0]);
      previousParam = params[0];
      extent = Math.hypot(coarseA[0], coarseA[1], coarseA[2]);
      let drawing = true;
      for (let i = 1; i < count; i++) {
        if (!sample(params[i], coarseB)) {
          drawing = false;
          continue;
        }
        if (!drawing) {
          previous.set(coarseB);
          previousAlpha = alpha(params[i]);
          previousParam = params[i];
          extent = Math.max(extent, Math.hypot(coarseB[0], coarseB[1], coarseB[2]));
          drawing = true;
          continue;
        }
        coarseA.set(previous);
        refine(previousParam, coarseA, params[i], coarseB, 0, count - 1 - i);
      }
      segments.needsUpdate = fades.needsUpdate = true;
      geometry.instanceCount = written;
      line.visible = written > 0;
      return written > 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      haloMaterial.dispose();
      line.removeFromParent();
    },
  };
}

export type Ribbon = ReturnType<typeof createRibbon>;
