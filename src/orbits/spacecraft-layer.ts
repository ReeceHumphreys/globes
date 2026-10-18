import * as THREE from "three/webgpu";
import { uniform } from "three/tsl";
import type { GlobeContext, GlobeFrame, GlobeLayer } from "../composition.ts";
import type { OrbitEphemeris } from "./ephemeris.ts";
import { createRibbon, type Ribbon } from "./ribbon.ts";

/**
 * "inertial" draws the path in a non-rotating frame centered on the body, so a closed orbit
 * stays closed while the body turns beneath it (Vizard's default). "fixed" draws the path
 * over the rotating surface. Ephemerides without an inertial state always draw "fixed".
 */
export type TrackFrame = "inertial" | "fixed";

export interface SpacecraftLayerOptions {
  id?: string;
  /** Initial simulation time in UTC milliseconds. Defaults to the wall clock. */
  timeMs?: number;
  /** Simulated seconds per real second. Zero pauses and stops continuous rendering. */
  rate?: number;
  /** Track length behind the spacecraft. Defaults to one period, or one hour. */
  trailSeconds?: number;
  /** Track length ahead of the spacecraft. Defaults to zero. */
  leadSeconds?: number;
  /** Coarse vertices per track; chords are refined further where the camera is close. */
  trackSamples?: number;
  /** Track width in CSS pixels, including its antialiased edge. Defaults to 3. */
  trackWidth?: number;
  /** Frame for the true-path track. Defaults to "inertial". */
  trackFrame?: TrackFrame;
  /** Draw the osculating (two-body) orbit from the current state. Defaults to false. */
  osculating?: boolean;
  /** Draw the true path projected onto the surface. Defaults to false. */
  groundTrack?: boolean;
  /** CSS color for a track and its default label dot. */
  color?: string | ((ephemeris: OrbitEphemeris) => string);
  className?: string;
  /** Called once per spacecraft during attach; use textContent for untrusted text. */
  createElement?: (ephemeris: OrbitEphemeris) => HTMLElement;
}

export interface SpacecraftLayer extends GlobeLayer {
  /** Current simulation time in UTC milliseconds. */
  getTimeMs(): number;
  setTimeMs(timeMs: number): void;
  getRate(): number;
  setRate(rate: number): void;
  setSpacecraftVisible(id: string, visible: boolean): void;
  setTracksVisible(visible: boolean): void;
  setTrackFrame(frame: TrackFrame): void;
  setOsculatingVisible(visible: boolean): void;
  setGroundTrackVisible(visible: boolean): void;
}

interface Craft {
  ephemeris: OrbitEphemeris;
  color: string;
  trailSeconds: number;
  leadSeconds: number;
  enabled: boolean;
  node?: HTMLElement;
  track?: Ribbon;
  osculating?: Ribbon;
  ground?: Ribbon;
  /** Samples keyed by time. Grid and refinement times repeat, so most frames hit the cache. */
  fixedCache: Map<number, Float64Array>;
  inertialCache: Map<number, Float64Array>;
  /** Inertial→fixed rotation at the current time, row-major. */
  rotation: Float64Array;
  shown: boolean;
  x: number;
  y: number;
}

/** Sphere-occlusion test from the camera; terrain is ignored. */
export function spacecraftVisible(
  camera: THREE.Vector3,
  point: ArrayLike<number>,
  radius: number,
): boolean {
  const vx = point[0] - camera.x,
    vy = point[1] - camera.y,
    vz = point[2] - camera.z;
  const length2 = vx * vx + vy * vy + vz * vz;
  if (length2 === 0) return true;
  const along = Math.min(
    1,
    Math.max(0, -(camera.x * vx + camera.y * vy + camera.z * vz) / length2),
  );
  const qx = camera.x + along * vx,
    qy = camera.y + along * vy,
    qz = camera.z + along * vz;
  // Spacecraft below the reference radius (descent, low lunar orbit) occlude at their own radius.
  const occluder = Math.min(radius, Math.hypot(point[0], point[1], point[2]) * 0.999);
  return qx * qx + qy * qy + qz * qz >= occluder * occluder;
}

/** Osculating conic from a state: perifocal axes, semi-major axis and eccentricity. */
export function osculatingElements(
  position: ArrayLike<number>,
  velocity: ArrayLike<number>,
  mu: number,
): { a: number; e: number; p: number[]; q: number[] } | undefined {
  const [rx, ry, rz] = [position[0], position[1], position[2]];
  const [vx, vy, vz] = [velocity[0], velocity[1], velocity[2]];
  const r = Math.hypot(rx, ry, rz),
    v2 = vx * vx + vy * vy + vz * vz;
  const hx = ry * vz - rz * vy,
    hy = rz * vx - rx * vz,
    hz = rx * vy - ry * vx;
  const h = Math.hypot(hx, hy, hz);
  const energy = v2 / 2 - mu / r;
  if (!(r > 0) || !(h > 0) || !(energy < 0)) return undefined;
  const a = -mu / (2 * energy);
  // Eccentricity vector: (v × h) / μ − r̂.
  const ex = (vy * hz - vz * hy) / mu - rx / r,
    ey = (vz * hx - vx * hz) / mu - ry / r,
    ez = (vx * hy - vy * hx) / mu - rz / r;
  const e = Math.hypot(ex, ey, ez);
  // Periapsis direction; a circle has none, so measure from the current position.
  const p = e > 1e-9 ? [ex / e, ey / e, ez / e] : [rx / r, ry / r, rz / r];
  const q = [(hy * p[2] - hz * p[1]) / h, (hz * p[0] - hx * p[2]) / h, (hx * p[1] - hy * p[0]) / h];
  return { a, e, p, q };
}

const TAU = 2 * Math.PI;
const OSCULATING_STEPS = 96;

/** Spacecraft labels and orbit lines for a small set of ephemerides, with its own clock. */
export function createSpacecraftLayer(
  spacecraft: readonly OrbitEphemeris[],
  options: SpacecraftLayerOptions = {},
): SpacecraftLayer {
  const samples = options.trackSamples ?? 128;
  if (!Number.isInteger(samples) || samples < 2) throw new RangeError("Invalid track samples");
  const trackWidth = options.trackWidth ?? 3;
  if (!(trackWidth > 0)) throw new RangeError("Invalid track width");
  let timeMs = options.timeMs ?? Date.now(),
    rate = options.rate ?? 1;
  if (!Number.isFinite(timeMs) || !Number.isFinite(rate))
    throw new RangeError("Invalid spacecraft time or rate");
  let trackFrame: TrackFrame = options.trackFrame ?? "inertial",
    showOsculating = options.osculating ?? false,
    showGround = options.groundTrack ?? false,
    tracksVisible = true;
  const ids = new Set<string>();
  const crafts: Craft[] = spacecraft.map((ephemeris) => {
    if (!ephemeris.id || ids.has(ephemeris.id))
      throw new Error(`Duplicate or empty spacecraft id: ${ephemeris.id}`);
    ids.add(ephemeris.id);
    const trailSeconds = options.trailSeconds ?? ephemeris.periodSeconds ?? 3600;
    const leadSeconds = options.leadSeconds ?? 0;
    if (!(trailSeconds >= 0) || !(leadSeconds >= 0) || !(trailSeconds + leadSeconds > 0))
      throw new RangeError(`Invalid track length for spacecraft ${ephemeris.id}`);
    const color =
      typeof options.color === "function" ? options.color(ephemeris) : (options.color ?? "#7fd4ff");
    return {
      ephemeris,
      color,
      trailSeconds,
      leadSeconds,
      enabled: true,
      fixedCache: new Map(),
      inertialCache: new Map(),
      rotation: new Float64Array(9),
      shown: false,
      x: NaN,
      y: NaN,
    };
  });
  // Each coarse chord can split many times where the camera is close; bound the total.
  const capacity = samples * 4 + 256;
  const point = new Float64Array(3),
    velocity = new Float64Array(3),
    projected = new THREE.Vector3();
  const params = new Float64Array(Math.max(samples, OSCULATING_STEPS) + 3);
  const group = new THREE.Group();
  group.name = "Spacecraft tracks";
  const occluderRadius = uniform(1);
  let context: GlobeContext | undefined,
    root: HTMLElement | undefined,
    lastNow: number | undefined,
    bodyRadius = 1;

  function advance(now: number): void {
    if (lastNow !== undefined) timeMs += (now - lastNow) * rate;
    lastNow = now;
  }

  function cached(
    cache: Map<number, Float64Array>,
    at: number,
    compute: (at: number, out: Float64Array) => boolean,
  ): Float64Array | undefined {
    let value = cache.get(at);
    if (!value) {
      if (!compute(at, point)) return undefined;
      if (cache.size > capacity * 4) cache.clear();
      cache.set(at, (value = Float64Array.from(point)));
    }
    return value;
  }

  function rotate(m: Float64Array, v: ArrayLike<number>, out: Float64Array): void {
    const x = v[0],
      y = v[1],
      z = v[2];
    out[0] = m[0] * x + m[1] * y + m[2] * z;
    out[1] = m[3] * x + m[4] * y + m[5] * z;
    out[2] = m[6] * x + m[7] * y + m[8] * z;
  }

  function canInertial(craft: Craft): boolean {
    const { ephemeris } = craft;
    return !!ephemeris.inertialStateAt && !!ephemeris.inertialToFixed;
  }

  /** Track opacity: brightest at the spacecraft, fading toward the tail; the future is dim. */
  function fade(craft: Craft, at: number): number {
    if (at > timeMs) return 0.25;
    const u = craft.trailSeconds ? 1 - (timeMs - at) / (craft.trailSeconds * 1000) : 1;
    return 0.04 + 0.86 * Math.max(0, u) ** 2;
  }

  /**
   * Coarse track times: a fixed grid inside the window plus its exact ends. Grid times do not
   * move as time advances, so neither do the vertices (or their cached refinements).
   */
  function trackParams(craft: Craft): number {
    const { ephemeris } = craft;
    const step = (craft.trailSeconds + craft.leadSeconds) * (1000 / samples);
    const start = Math.max(timeMs - craft.trailSeconds * 1000, ephemeris.startMs ?? -Infinity);
    const stop = Math.min(timeMs + craft.leadSeconds * 1000, ephemeris.stopMs ?? Infinity);
    if (!(stop > start)) return 0;
    let count = 0;
    params[count++] = start;
    for (let k = Math.floor(start / step) + 1; k * step < stop && count < samples + 1; k++)
      params[count++] = k * step;
    params[count++] = stop;
    return count;
  }

  function drawLines(craft: Craft, origin: THREE.Vector3, tolerance: number): void {
    const { ephemeris } = craft;
    const visible = tracksVisible && craft.enabled;
    const inertial = canInertial(craft) && ephemeris.inertialToFixed!(timeMs, craft.rotation);
    const fixedAt = (at: number, out: Float64Array) => ephemeris.positionAt(at, out);
    const inertialAt = (at: number, out: Float64Array) => ephemeris.inertialStateAt!(at, out);
    const count = visible ? trackParams(craft) : 0;

    // True path, in the chosen frame.
    const track = craft.track!;
    if (count >= 2) {
      const useInertial = inertial && trackFrame === "inertial";
      track.draw(
        origin,
        params,
        count,
        (at, out) => {
          const raw = useInertial
            ? cached(craft.inertialCache, at, inertialAt)
            : cached(craft.fixedCache, at, fixedAt);
          if (!raw) return false;
          if (useInertial) rotate(craft.rotation, raw, out);
          else out.set(raw);
          return true;
        },
        (at) => fade(craft, at),
        tolerance,
      );
    } else track.object.visible = false;

    // Ground track: the fixed-frame path projected onto the reference sphere.
    const ground = craft.ground!;
    if (showGround && count >= 2) {
      ground.draw(
        origin,
        params,
        count,
        (at, out) => {
          const raw = cached(craft.fixedCache, at, fixedAt);
          if (!raw) return false;
          const scale = bodyRadius / Math.hypot(raw[0], raw[1], raw[2]);
          out[0] = raw[0] * scale;
          out[1] = raw[1] * scale;
          out[2] = raw[2] * scale;
          return true;
        },
        (at) => 0.8 * fade(craft, at),
        tolerance,
      );
    } else ground.object.visible = false;

    // Osculating ellipse from the current inertial state, parameterized by eccentric anomaly.
    const osculating = craft.osculating!;
    const mu = ephemeris.mu;
    const elements =
      visible &&
      showOsculating &&
      inertial &&
      mu &&
      ephemeris.inertialStateAt!(timeMs, point, velocity)
        ? osculatingElements(point, velocity, mu)
        : undefined;
    if (elements) {
      const { a, e, p, q } = elements;
      const b = a * Math.sqrt(1 - e * e);
      const local = new Float64Array(3);
      for (let i = 0; i <= OSCULATING_STEPS; i++) params[i] = (i / OSCULATING_STEPS) * TAU;
      osculating.draw(
        origin,
        params,
        OSCULATING_STEPS + 1,
        (E, out) => {
          const x = a * (Math.cos(E) - e),
            y = b * Math.sin(E);
          for (let k = 0; k < 3; k++) local[k] = x * p[k] + y * q[k];
          rotate(craft.rotation, local, out);
          return true;
        },
        () => 0.45,
        tolerance,
      );
    } else osculating.object.visible = false;
  }

  function updateLabel(craft: Craft, visible: boolean): void {
    const node = craft.node!;
    if (craft.shown !== visible) {
      node.hidden = !visible;
      node.style.visibility = visible ? "visible" : "hidden";
      craft.shown = visible;
    }
    if (!visible) return;
    const { width, height } = context!.viewport;
    const x = Math.round((projected.x * 0.5 + 0.5) * width * 100) / 100;
    const y = Math.round((-projected.y * 0.5 + 0.5) * height * 100) / 100;
    if (craft.x !== x || craft.y !== y) {
      node.style.translate = `${x}px ${y}px`;
      craft.x = x;
      craft.y = y;
    }
  }

  const changed = () => context?.requestRender();
  return {
    id: options.id ?? "spacecraft",
    attach(next: GlobeContext) {
      const body = next.body.name.toLowerCase();
      for (const { ephemeris } of crafts)
        if (ephemeris.center.toLowerCase() !== body)
          throw new Error(
            `Spacecraft ${ephemeris.id} orbits ${ephemeris.center}, not ${next.body.name}`,
          );
      context = next;
      bodyRadius = next.body.radiusMeters;
      occluderRadius.value = bodyRadius;
      root = document.createElement("div");
      root.className = options.className ?? "globe-spacecraft";
      Object.assign(root.style, {
        position: "absolute",
        inset: "0",
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: "1",
        color: "#fff",
        font: "12px sans-serif",
        textShadow: "0 1px 2px #000",
      });
      for (const craft of crafts) {
        let node = options.createElement?.(craft.ephemeris);
        if (!node) {
          node = document.createElement("span");
          const dot = document.createElement("span");
          Object.assign(dot.style, {
            display: "inline-block",
            width: "6px",
            height: "6px",
            marginRight: "5px",
            borderRadius: "50%",
            background: craft.color,
            verticalAlign: "middle",
          });
          node.append(dot, craft.ephemeris.name);
          node.style.transform = "translate(-3px, -50%)";
          node.style.whiteSpace = "nowrap";
        }
        node.dataset.spacecraftId = craft.ephemeris.id;
        Object.assign(node.style, { position: "absolute", left: "0", top: "0" });
        node.hidden = true;
        node.style.visibility = "hidden";
        root.append(node);
        craft.node = node;

        const name = craft.ephemeris.name;
        craft.track = createRibbon({
          name: `Spacecraft track · ${name}`,
          color: craft.color,
          width: trackWidth,
          opacity: 1,
          occluderRadius,
          capacity,
        });
        craft.osculating = createRibbon({
          name: `Osculating orbit · ${name}`,
          color: craft.color,
          width: Math.max(1.5, trackWidth - 1),
          opacity: 1,
          occluderRadius,
          capacity,
        });
        // On the surface itself, so the occluder sits just inside it.
        craft.ground = createRibbon({
          name: `Ground track · ${name}`,
          color: craft.color,
          width: Math.max(1.5, trackWidth - 1),
          opacity: 1,
          occluderRadius,
          occluderScale: 0.995,
          capacity,
        });
        group.add(craft.track.object, craft.osculating.object, craft.ground.object);
      }
      next.container.append(root);
      next.overlay.add(group);
    },
    prepare(now: number) {
      advance(now);
    },
    update({ context, now }: GlobeFrame) {
      advance(now); // No-op after prepare for the same frame.
      const { camera } = context;
      const basis = camera.matrixWorld.elements;
      // Rebase every line on the camera, so nearby vertices are small and exact in float32.
      group.position.copy(camera.position);
      // Half a pixel, as an angle: chords bending further from the curve are subdivided.
      const tolerance =
        (0.5 * THREE.MathUtils.degToRad(camera.fov)) / Math.max(1, context.viewport.height);
      let extent = 0;
      for (const craft of crafts) {
        drawLines(craft, camera.position, tolerance);
        for (const ribbon of [craft.track!, craft.osculating!, craft.ground!])
          if (ribbon.object.visible) extent = Math.max(extent, ribbon.extent);
        let visible = craft.enabled && craft.ephemeris.positionAt(timeMs, point);
        if (visible) {
          const cx = point[0] - camera.position.x,
            cy = point[1] - camera.position.y,
            cz = point[2] - camera.position.z;
          visible =
            cx * -basis[8] + cy * -basis[9] + cz * -basis[10] > 0 &&
            spacecraftVisible(camera.position, point, context.body.radiusMeters);
          if (visible) {
            extent = Math.max(extent, Math.hypot(point[0], point[1], point[2]));
            projected.set(point[0], point[1], point[2]).project(camera);
            visible = Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
          }
        }
        updateLabel(craft, visible);
      }
      // The engine sizes the far plane for the body alone; keep distant orbits unclipped.
      const far = camera.position.length() + extent;
      if (far > camera.far) {
        camera.far = far;
        camera.updateProjectionMatrix();
      }
      if (rate !== 0) context.requestRender();
    },
    getTimeMs() {
      return timeMs;
    },
    setTimeMs(next: number) {
      if (!Number.isFinite(next)) throw new RangeError("Invalid spacecraft time");
      timeMs = next;
      changed();
    },
    getRate() {
      return rate;
    },
    setRate(next: number) {
      if (!Number.isFinite(next)) throw new RangeError("Invalid spacecraft rate");
      rate = next;
      changed();
    },
    setSpacecraftVisible(id: string, visible: boolean) {
      const craft = crafts.find((craft) => craft.ephemeris.id === id);
      if (!craft) throw new Error(`Unknown spacecraft id: ${id}`);
      craft.enabled = visible;
      changed();
    },
    setTracksVisible(visible: boolean) {
      tracksVisible = visible;
      changed();
    },
    setTrackFrame(frame: TrackFrame) {
      if (frame !== "inertial" && frame !== "fixed") throw new RangeError(`Unknown frame ${frame}`);
      trackFrame = frame;
      changed();
    },
    setOsculatingVisible(visible: boolean) {
      showOsculating = visible;
      changed();
    },
    setGroundTrackVisible(visible: boolean) {
      showGround = visible;
      changed();
    },
    dispose() {
      group.removeFromParent();
      for (const craft of crafts) {
        for (const ribbon of [craft.track, craft.osculating, craft.ground]) ribbon?.dispose();
        craft.track = craft.osculating = craft.ground = craft.node = undefined;
        craft.fixedCache.clear();
        craft.inertialCache.clear();
      }
      group.clear();
      root?.remove();
      root = undefined;
      context = undefined;
    },
  };
}
