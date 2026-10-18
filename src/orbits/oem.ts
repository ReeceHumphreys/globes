import { centerMu, osculatingPeriod, type OrbitEphemeris } from "./ephemeris.ts";
import {
  resolveFrame,
  sceneMatrix,
  toScene,
  TT_MINUS_UTC_SECONDS,
  type FrameResolver,
  type FrameTransform,
} from "./frames.ts";

export interface OemOptions {
  /** Supplies rotations for frames or centers the library does not know. */
  frames?: FrameResolver;
}

/** Seconds added to convert each supported time system to UTC (TAI−UTC fixed at 37 s). */
const TO_UTC_SECONDS: Record<string, number> = {
  UTC: 0,
  UT1: 0,
  TAI: -37,
  GPS: -18,
  TT: -TT_MINUS_UTC_SECONDS,
  TDB: -TT_MINUS_UTC_SECONDS,
};

interface Segment {
  startMs: number;
  stopMs: number;
  /** First record epoch; record times are seconds after it, keeping interpolation well conditioned. */
  originMs: number;
  times: Float64Array;
  /** Position and velocity per record, in meters and meters per second. */
  states: Float64Array;
  /** Points used per interpolation and whether velocities participate. */
  points: number;
  hermite: boolean;
  transform: FrameTransform;
  /** True when the reference frame does not rotate with the body (EME2000, ICRF, TEME…). */
  inertial: boolean;
}

const INERTIAL_FRAMES = new Set(["EME2000", "J2000", "ICRF", "ICRF2", "ICRF3", "GCRF", "TEME"]);

/** CCSDS epochs: calendar (YYYY-MM-DD) or ordinal (YYYY-DDD), optional fraction and Z. */
export function parseCcsdsEpoch(text: string, timeSystem = "UTC"): number {
  const match = /^(\d{4})-(?:(\d{2})-(\d{2})|(\d{3}))T(\d{2}):(\d{2}):(\d{2}(?:\.\d*)?)Z?$/.exec(
    text.trim(),
  );
  const offset = TO_UTC_SECONDS[timeSystem.trim().toUpperCase()];
  if (offset === undefined) throw new RangeError(`Unsupported OEM time system ${timeSystem}`);
  if (!match) throw new SyntaxError(`Invalid CCSDS epoch ${text}`);
  const [, year, month, day, ordinal, hour, minute, second] = match;
  const y = Number(year),
    h = Number(hour),
    min = Number(minute),
    sec = Number(second);
  const midnight = ordinal
    ? Date.UTC(y, 0, Number(ordinal))
    : Date.UTC(y, Number(month) - 1, Number(day));
  // Date.UTC rolls impossible dates forward. Require the calendar fields to survive that.
  const civil = midnight + (h * 3600 + min * 60 + sec) * 1000;
  const back = new Date(civil);
  const backYear = back.getUTCFullYear();
  const ordinalDay =
    Math.round(
      (Date.UTC(backYear, back.getUTCMonth(), back.getUTCDate()) - Date.UTC(backYear, 0, 1)) /
        86400000,
    ) + 1;
  const sameDay = ordinal
    ? backYear === y && ordinalDay === Number(ordinal)
    : backYear === y &&
      back.getUTCMonth() + 1 === Number(month) &&
      back.getUTCDate() === Number(day);
  const sameClock =
    back.getUTCHours() === h &&
    back.getUTCMinutes() === min &&
    Math.abs(back.getUTCSeconds() + back.getUTCMilliseconds() / 1000 - sec) < 1e-3;
  if (!sameDay || !sameClock) throw new SyntaxError(`Invalid CCSDS epoch ${text}`);
  return civil + offset * 1000;
}

/**
 * Parse a CCSDS Orbit Ephemeris Message in KVN (text) form, returning one ephemeris per
 * OBJECT_ID with its segments in file order. Covariance blocks are skipped. XML OEMs are
 * not supported.
 */
export function parseOem(text: string, options: OemOptions = {}): OrbitEphemeris[] {
  const lines = text.split(/\r?\n/);
  const objects = new Map<string, { name: string; center: string; segments: Segment[] }>();
  let version = false,
    meta: Record<string, string> | undefined,
    data: number[][] = [],
    inMeta = false,
    inCovariance = false;
  const flush = () => {
    if (!meta) return;
    const segment = buildSegment(meta, data, options.frames);
    const id = meta.OBJECT_ID ?? meta.OBJECT_NAME;
    if (!id) throw new SyntaxError("OEM segment lacks OBJECT_ID");
    const object = objects.get(id);
    if (object && object.center.toUpperCase() !== meta.CENTER_NAME.toUpperCase())
      throw new SyntaxError(`OEM object ${id} changes CENTER_NAME between segments`);
    if (object) object.segments.push(segment);
    else
      objects.set(id, {
        name: meta.OBJECT_NAME ?? id,
        center: meta.CENTER_NAME,
        segments: [segment],
      });
    meta = undefined;
    data = [];
  };
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("COMMENT")) return;
    if (inCovariance) {
      if (line === "COVARIANCE_STOP") inCovariance = false;
      return;
    }
    if (line === "COVARIANCE_START") {
      inCovariance = true;
      return;
    }
    if (line === "META_START") {
      flush();
      meta = {};
      inMeta = true;
      return;
    }
    if (line === "META_STOP") {
      if (!inMeta) throw new SyntaxError(`Unexpected META_STOP on line ${index + 1}`);
      inMeta = false;
      return;
    }
    const pair = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (inMeta) {
      if (!pair) throw new SyntaxError(`Invalid OEM metadata on line ${index + 1}`);
      meta![pair[1]] = pair[2].trim();
      return;
    }
    if (!meta) {
      if (pair?.[1] === "CCSDS_OEM_VERS") version = true;
      return; // Header keywords: originator, creation date, message ID.
    }
    const fields = line.split(/\s+/);
    if (fields.length !== 7 && fields.length !== 10)
      throw new SyntaxError(`Invalid OEM ephemeris record on line ${index + 1}`);
    const record = [parseCcsdsEpoch(fields[0], meta.TIME_SYSTEM)];
    for (let i = 1; i < 7; i++) record.push(Number(fields[i]) * 1000);
    if (record.some((value) => !Number.isFinite(value)))
      throw new SyntaxError(`Invalid OEM number on line ${index + 1}`);
    data.push(record);
  });
  if (inMeta) throw new SyntaxError("Unterminated OEM metadata block");
  flush();
  if (!version) throw new SyntaxError("Not a KVN OEM: CCSDS_OEM_VERS is missing");
  if (!objects.size) throw new SyntaxError("OEM contains no segments");
  return [...objects].map(([id, object]) => oemEphemeris(id, object));
}

function buildSegment(
  meta: Record<string, string>,
  data: number[][],
  resolver?: FrameResolver,
): Segment {
  for (const key of ["CENTER_NAME", "REF_FRAME", "TIME_SYSTEM", "START_TIME", "STOP_TIME"])
    if (!meta[key]) throw new SyntaxError(`OEM metadata lacks ${key}`);
  if (meta.REF_FRAME_EPOCH)
    throw new RangeError("OEM REF_FRAME_EPOCH is not supported; supply J2000-epoch frames");
  const epoch = (key: string) =>
    meta[key] ? parseCcsdsEpoch(meta[key], meta.TIME_SYSTEM) : undefined;
  const startMs = epoch("USEABLE_START_TIME") ?? epoch("START_TIME")!;
  const stopMs = epoch("USEABLE_STOP_TIME") ?? epoch("STOP_TIME")!;
  if (data.length < 2) throw new SyntaxError("OEM segment needs at least two records");
  for (let i = 1; i < data.length; i++)
    if (!(data[i][0] > data[i - 1][0])) throw new SyntaxError("OEM epochs must increase");
  if (!(stopMs > startMs) || startMs < data[0][0] || stopMs > data.at(-1)![0])
    throw new SyntaxError("OEM usable time span lies outside its ephemeris records");
  const method = (meta.INTERPOLATION ?? "HERMITE").toUpperCase();
  if (!["HERMITE", "LAGRANGE", "LINEAR"].includes(method))
    throw new RangeError(`Unsupported OEM interpolation ${method}`);
  const hermite = method === "HERMITE";
  const degree = method === "LINEAR" ? 1 : Number(meta.INTERPOLATION_DEGREE ?? 5);
  if (!Number.isInteger(degree) || degree < 1)
    throw new RangeError(`Invalid OEM interpolation degree ${meta.INTERPOLATION_DEGREE}`);
  const origin = data[0][0];
  return {
    startMs,
    stopMs,
    originMs: origin,
    times: Float64Array.from(data, (record) => (record[0] - origin) / 1000),
    states: Float64Array.from(data.flatMap((record) => record.slice(1))),
    points: Math.min(data.length, hermite ? Math.ceil((degree + 1) / 2) : degree + 1),
    hermite,
    transform: resolveFrame(meta.CENTER_NAME, meta.REF_FRAME, resolver),
    inertial: INERTIAL_FRAMES.has(meta.REF_FRAME.trim().toUpperCase()),
  };
}

function oemEphemeris(
  id: string,
  object: { name: string; center: string; segments: Segment[] },
): OrbitEphemeris {
  const { segments } = object;
  const vector = new Float64Array(3);
  const first = segments[0].states;
  const find = (timeMs: number) => {
    // Later segments take precedence at shared boundaries.
    for (let s = segments.length - 1; s >= 0; s--)
      if (timeMs >= segments[s].startMs && timeMs <= segments[s].stopMs) return segments[s];
    return undefined;
  };
  const inertial = segments.every((segment) => segment.inertial);
  const velocity = new Float64Array(3);
  return {
    id,
    name: object.name,
    center: object.center,
    startMs: Math.min(...segments.map((segment) => segment.startMs)),
    stopMs: Math.max(...segments.map((segment) => segment.stopMs)),
    periodSeconds: osculatingPeriod(object.center, first, first.subarray(3, 6)),
    mu: centerMu(object.center),
    positionAt(timeMs, out) {
      const segment = find(timeMs);
      if (!segment) return false;
      interpolate(segment, (timeMs - segment.originMs) / 1000, vector);
      segment.transform(timeMs, vector);
      toScene(vector, out);
      return true;
    },
    ...(inertial && {
      inertialStateAt(
        timeMs: number,
        position: { [index: number]: number },
        out?: { [index: number]: number },
      ) {
        const segment = find(timeMs);
        if (!segment) return false;
        interpolate(segment, (timeMs - segment.originMs) / 1000, vector, out && velocity);
        toScene(vector, position);
        if (out) toScene(velocity, out);
        return true;
      },
      inertialToFixed(timeMs: number, out: { [index: number]: number }) {
        const segment = find(timeMs);
        if (!segment) return false;
        sceneMatrix(segment.transform, timeMs, out);
        return true;
      },
    }),
  };
}

const scratchTimes = new Float64Array(64);
const scratchValues = new Float64Array(64);

/** Window of `points` records centered on t, then Lagrange or Hermite per axis. */
function interpolate(
  segment: Segment,
  t: number,
  out: Float64Array,
  velocity?: Float64Array,
): void {
  const { times, states, points } = segment;
  let low = 0,
    high = times.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (times[mid] <= t) low = mid;
    else high = mid;
  }
  const start = Math.max(0, Math.min(times.length - points, low - ((points - 1) >> 1)));
  for (let axis = 0; axis < 3; axis++)
    out[axis] = segment.hermite
      ? hermiteAxis(times, states, start, points, axis, t)
      : lagrangeAxis(times, states, start, points, axis, t);
  // Velocities are tabulated too; interpolate them directly (columns 3–5).
  if (velocity)
    for (let axis = 0; axis < 3; axis++)
      velocity[axis] = lagrangeAxis(
        times,
        states,
        start,
        Math.min(Math.max(2, points), times.length - start),
        axis + 3,
        t,
      );
}

function lagrangeAxis(
  times: Float64Array,
  states: Float64Array,
  start: number,
  points: number,
  axis: number,
  t: number,
): number {
  let sum = 0;
  for (let i = start; i < start + points; i++) {
    let weight = 1;
    for (let j = start; j < start + points; j++)
      if (j !== i) weight *= (t - times[j]) / (times[i] - times[j]);
    sum += weight * states[i * 6 + axis];
  }
  return sum;
}

// Newton divided differences over doubled nodes, matching value and first derivative.
function hermiteAxis(
  times: Float64Array,
  states: Float64Array,
  start: number,
  points: number,
  axis: number,
  t: number,
): number {
  const n = points * 2;
  if (n > scratchTimes.length) throw new RangeError("OEM interpolation degree is too high");
  const z = scratchTimes,
    q = scratchValues;
  for (let i = 0; i < points; i++) {
    const record = start + i;
    z[2 * i] = z[2 * i + 1] = times[record];
    q[2 * i] = q[2 * i + 1] = states[record * 6 + axis];
  }
  // Column 1, in place from the bottom so each entry still sees its unmodified predecessor.
  for (let i = n - 1; i >= 1; i--)
    q[i] =
      i % 2 === 1
        ? states[(start + (i >> 1)) * 6 + 3 + axis]
        : (q[i] - q[i - 1]) / (z[i] - z[i - 1]);
  for (let level = 2; level < n; level++)
    for (let i = n - 1; i >= level; i--) q[i] = (q[i] - q[i - 1]) / (z[i] - z[i - level]);
  let result = q[n - 1];
  for (let i = n - 2; i >= 0; i--) result = result * (t - z[i]) + q[i];
  return result;
}
