import assert from "node:assert/strict";
import test from "node:test";
import { eciToEcf, gstime, propagate, twoline2satrec } from "satellite.js";
import { greenwichMeanSiderealTime, resolveFrame } from "../src/orbits/frames.ts";
import { parseTle } from "../src/orbits/tle.ts";
import { parseCcsdsEpoch, parseOem } from "../src/orbits/oem.ts";

// Vanguard 1, from the SGP4 verification set (Vallado et al. 2006).
const LINE1 = "1 00005U 58002B   00179.78495062  .00000023  00000-0  28098-4 0  4753";
const LINE2 = "2 00005  34.2682 348.7242 1859667 331.7664  19.3264 10.82419157413667";

test("CCSDS epochs accept calendar and ordinal dates, fractions, Z, and time systems", () => {
  const utc = Date.UTC(2024, 1, 29, 12, 30, 15, 250);
  assert.equal(parseCcsdsEpoch("2024-02-29T12:30:15.25"), utc);
  assert.equal(parseCcsdsEpoch("2024-060T12:30:15.250Z"), utc);
  assert.equal(parseCcsdsEpoch("2024-02-29T12:30:52.25", "TAI"), utc);
  assert.equal(parseCcsdsEpoch("2024-02-29T12:30:33.25", "gps"), utc);
  assert.ok(Math.abs(parseCcsdsEpoch("2024-02-29T12:31:24.434", "TT") - utc) < 1e-6);
  assert.equal(parseCcsdsEpoch("2024-366T00:00:00Z"), Date.UTC(2024, 11, 31));
  assert.throws(() => parseCcsdsEpoch("2024-02-29 12:30:15"), SyntaxError);
  assert.throws(() => parseCcsdsEpoch("2024-02-29T12:30:15", "TCB"), RangeError);
  assert.throws(() => parseCcsdsEpoch("2023-02-31T00:00:00Z"), SyntaxError);
  assert.throws(() => parseCcsdsEpoch("2023-366T00:00:00Z"), SyntaxError);
  assert.throws(() => parseCcsdsEpoch("2024-02-29T24:00:00Z"), SyntaxError);
  assert.throws(() => parseCcsdsEpoch("2024-02-29T12:60:00Z"), SyntaxError);
});

test("a failed orbit sample ends the line instead of bridging the gap", async () => {
  const { createRibbon } = await import("../src/orbits/ribbon.ts");
  const { Vector3 } = await import("three/webgpu");
  const { float } = await import("three/tsl");
  const ribbon = createRibbon({
    name: "gap",
    color: "#fff",
    width: 2,
    opacity: 1,
    occluderRadius: float(1),
    capacity: 8,
  });
  const drawn = ribbon.draw(
    new Vector3(),
    [0, 1, 2, 3, 4],
    5,
    (p, out) => {
      if (p === 2) return false;
      out[0] = p * 10;
      out[1] = 0;
      out[2] = 0;
      return true;
    },
    () => 1,
    1e9,
  );
  assert.equal(drawn, true);
  assert.equal(ribbon.segmentCount, 2);
  const positions = (
    ribbon.object.geometry.attributes
      .instanceStart as import("three/webgpu").InterleavedBufferAttribute
  ).data.array as Float32Array;
  assert.deepEqual(Array.from(positions.subarray(0, 6)), [0, 0, 0, 10, 0, 0]);
  assert.deepEqual(Array.from(positions.subarray(6, 12)), [30, 0, 0, 40, 0, 0]);
  ribbon.dispose();
});

test("GMST matches satellite.js", () => {
  for (const ms of [Date.UTC(1980, 0, 1), Date.UTC(2000, 0, 1, 12), Date.UTC(2031, 6, 4, 3, 2, 1)])
    assert.ok(Math.abs(greenwichMeanSiderealTime(ms) - gstime(new Date(ms))) < 1e-9);
});

test("J2000 to ITRF agrees with Vallado's FK5 example to about a kilometer", () => {
  // Example 3-15: nutation, polar motion and UT1−UTC are omitted here.
  const time = Date.UTC(2004, 3, 6, 7, 51, 28, 386.009);
  const v = new Float64Array([5102.508958, 6123.011401, 6378.136928]);
  resolveFrame("EARTH", "EME2000")(time, v);
  const expected = [-1033.479383, 7901.2952754, 6380.3565958];
  const error = Math.hypot(v[0] - expected[0], v[1] - expected[1], v[2] - expected[2]);
  assert.ok(error < 1.5, `error ${error} km`);
});

test("IAU Moon and Mars frames use the published poles and rotation rates", () => {
  const J2000 = Date.UTC(2000, 0, 1, 12) - 69_184;
  for (const [center, alpha, delta, rate] of [
    ["MOON", 269.9949, 66.5392, 13.17635815],
    ["MARS", 317.68143, 52.8865, 350.89198226],
  ] as const) {
    const transform = resolveFrame(center, "ICRF");
    const a = (alpha * Math.PI) / 180,
      d = (delta * Math.PI) / 180;
    // The Moon's pole wobbles by ~4° through its periodic terms; Mars has none.
    const tolerance = center === "MOON" ? 0.08 : 1e-9;
    const pole = new Float64Array([
      Math.cos(d) * Math.cos(a),
      Math.cos(d) * Math.sin(a),
      Math.sin(d),
    ]);
    transform(J2000, pole);
    assert.ok(pole[2] >= Math.cos(tolerance), `${center} pole ${pole[2]}`);
    // A body-fixed meridian returns after one sidereal day.
    const sidereal = (360 / rate) * 86_400_000;
    const later = new Float64Array([1, 0, 0]),
      now = new Float64Array([1, 0, 0]);
    transform(J2000 + 10 * sidereal, now);
    transform(J2000 + 11 * sidereal, later);
    const drift = Math.acos(Math.min(1, now[0] * later[0] + now[1] * later[1] + now[2] * later[2]));
    assert.ok(drift < (center === "MOON" ? 0.01 : 1e-6), `${center} drift ${drift}`);
  }
  assert.throws(() => resolveFrame("JUPITER", "ICRF"), /Unsupported/);
  assert.throws(() => resolveFrame("MOON", "TEME"), /Unsupported/);
  assert.throws(() => resolveFrame("MOON", "ITRF2014"), /Unsupported/);
});

test("TLE ephemerides match satellite.js Earth-fixed positions in scene axes", () => {
  const [craft] = parseTle(`0 VANGUARD 1\n${LINE1}\n${LINE2}\n`);
  assert.equal(craft.id, "00005");
  assert.equal(craft.name, "VANGUARD 1");
  assert.equal(craft.center, "Earth");
  // SGP4 recovers the Brouwer mean motion, slightly different from the TLE's Kozai value.
  assert.ok(Math.abs(craft.periodSeconds! / (86400 / 10.82419157) - 1) < 1e-3);
  const satrec = twoline2satrec(LINE1, LINE2);
  const out = [0, 0, 0];
  for (const ms of [Date.UTC(2000, 5, 27, 18, 50), Date.UTC(2000, 6, 4)]) {
    assert.equal(craft.positionAt(ms, out), true);
    const state = propagate(satrec, new Date(ms))!;
    const ecf = eciToEcf(
      state.position as { x: number; y: number; z: number },
      gstime(new Date(ms)),
    );
    assert.ok(Math.abs(out[0] - ecf.x * 1000) < 0.05);
    assert.ok(Math.abs(out[1] - ecf.z * 1000) < 0.05);
    assert.ok(Math.abs(out[2] + ecf.y * 1000) < 0.05);
  }
  assert.equal(parseTle(`${LINE1}\n${LINE2}`)[0].name, "00005");
  // Alpha-5 catalog numbers (A0930 = 100930); checksums count digits only.
  const [alpha] = parseTle(`SPICY OTTER
1 A0930U 26227AZ  26297.30060553  .00002031  00000-0  10474-3 0  9994
2 A0930  97.4435   6.4291 0003644  87.1404 273.0246 15.17470173  3428`);
  assert.equal(alpha.id, "A0930");
  assert.equal(alpha.positionAt(Date.UTC(2026, 9, 24, 12), out), true);
  const altitude = Math.hypot(out[0], out[1], out[2]) - 6_378_137;
  assert.ok(altitude > 480_000 && altitude < 540_000, `altitude ${altitude}`);
  assert.throws(() => parseTle(`${LINE1}\n${LINE2.slice(0, -1)}8`), /checksum/);
  assert.throws(() => parseTle(`NAME\n${LINE1}`), /Expected TLE/);
});

const MU = 3.986004418e14;
/** Inclined circular two-body orbit sampled into a KVN OEM, in kilometers. */
function circularOem(options: {
  radius: number;
  stepSeconds: number;
  count: number;
  frame?: string;
  interpolation?: string;
  extra?: string;
}) {
  const n = Math.sqrt(MU / options.radius ** 3);
  const start = Date.UTC(2026, 0, 1);
  const state = (seconds: number) => {
    const u = n * seconds,
      i = 0.9;
    const speed = n * options.radius;
    return [
      options.radius * Math.cos(u),
      options.radius * Math.sin(u) * Math.cos(i),
      options.radius * Math.sin(u) * Math.sin(i),
      -speed * Math.sin(u),
      speed * Math.cos(u) * Math.cos(i),
      speed * Math.cos(u) * Math.sin(i),
    ];
  };
  const epoch = (seconds: number) => new Date(start + seconds * 1000).toISOString().slice(0, -1);
  const records = Array.from({ length: options.count }, (_, k) => {
    const t = k * options.stepSeconds;
    return [epoch(t), ...state(t).map((value) => (value / 1000).toFixed(9))].join(" ");
  });
  const stop = (options.count - 1) * options.stepSeconds;
  const text = `CCSDS_OEM_VERS = 2.0
CREATION_DATE = 2026-01-01T00:00:00
ORIGINATOR = TEST

META_START
OBJECT_NAME = TEST SAT
OBJECT_ID = 2026-001A
CENTER_NAME = EARTH
REF_FRAME = ${options.frame ?? "TEST"}
TIME_SYSTEM = UTC
START_TIME = ${epoch(0)}
STOP_TIME = ${epoch(stop)}
${options.interpolation ?? ""}
META_STOP
COMMENT synthetic
${records.join("\n")}
COVARIANCE_START
EPOCH = ${epoch(0)}
COV_REF_FRAME = RTN
1.0
COVARIANCE_STOP
${options.extra ?? ""}`;
  return { text, start, stop, state };
}

test("OEM Hermite and Lagrange interpolation reproduce a two-body orbit", () => {
  const identity = () => () => {};
  for (const interpolation of [
    "INTERPOLATION = HERMITE\nINTERPOLATION_DEGREE = 7",
    "INTERPOLATION = LAGRANGE\nINTERPOLATION_DEGREE = 9",
    "",
  ]) {
    const oem = circularOem({ radius: 7_000_000, stepSeconds: 60, count: 200, interpolation });
    const [craft] = parseOem(oem.text, { frames: identity });
    assert.equal(craft.id, "2026-001A");
    assert.equal(craft.name, "TEST SAT");
    assert.equal(craft.startMs, oem.start);
    assert.ok(Math.abs(craft.periodSeconds! - 2 * Math.PI * Math.sqrt(7e6 ** 3 / MU)) < 1e-3);
    const out = [0, 0, 0];
    let worst = 0;
    for (const seconds of [0, 17.3, 3001.7, 5970, oem.stop - 13, oem.stop]) {
      assert.equal(craft.positionAt(oem.start + seconds * 1000, out), true);
      const [x, y, z] = oem.state(seconds);
      worst = Math.max(worst, Math.hypot(out[0] - x, out[1] - z, out[2] + y));
    }
    assert.ok(worst < 0.05, `${interpolation || "default"}: ${worst} m`);
    assert.equal(craft.positionAt(oem.start - 1, out), false);
    assert.equal(craft.positionAt(oem.start + oem.stop * 1000 + 1, out), false);
  }
});

test("OEM objects group segments, honor usable spans, and reject unsupported input", () => {
  const second = `META_START
OBJECT_NAME = OTHER
OBJECT_ID = 2026-002A
CENTER_NAME = EARTH
REF_FRAME = ITRF2014
TIME_SYSTEM = UTC
START_TIME = 2026-01-01T00:00:00
USEABLE_START_TIME = 2026-01-01T00:00:30
STOP_TIME = 2026-01-01T00:02:00
INTERPOLATION = LINEAR
META_STOP
2026-01-01T00:00:00 7000 0 0 0 7 0
2026-01-01T00:01:00 7000 420 0 0 7 0
2026-01-01T00:02:00 7000 840 0 0 7 0`;
  const oem = circularOem({
    radius: 7_000_000,
    stepSeconds: 60,
    count: 20,
    frame: "EME2000",
    extra: second,
  });
  const [first, other] = parseOem(oem.text);
  assert.equal(first.id, "2026-001A");
  assert.equal(other.id, "2026-002A");
  const out = [0, 0, 0];
  assert.equal(other.positionAt(Date.UTC(2026, 0, 1, 0, 0, 15), out), false);
  assert.equal(other.positionAt(Date.UTC(2026, 0, 1, 0, 1, 30), out), true);
  assert.deepEqual(out, [7_000_000, 0, -630_000]);
  // EME2000 rotates into Earth-fixed axes but keeps the orbital radius.
  assert.equal(first.positionAt(oem.start + 90_000, out), true);
  assert.ok(Math.abs(Math.hypot(out[0], out[1], out[2]) - 7_000_000) < 1);

  assert.throws(() => parseOem(oem.text.replace("CCSDS_OEM_VERS = 2.0", "")), /CCSDS_OEM_VERS/);
  assert.throws(() => parseOem(oem.text.replace("EME2000", "LVLH")), /Unsupported reference frame/);
  assert.throws(() => parseOem(oem.text.replace("REF_FRAME = EME2000", "")), /REF_FRAME/);
  assert.throws(
    () => parseOem(oem.text.replace("INTERPOLATION = LINEAR", "INTERPOLATION = SPLINE")),
    /interpolation/,
  );
  assert.throws(
    () =>
      parseOem(oem.text.replace("2026-01-01T00:01:00 7000 420", "2026-01-01T00:03:00 7000 420")),
    /epochs must increase/,
  );
});

class Element {
  hidden = false;
  removed = false;
  dataset: Record<string, string> = {};
  className = "";
  children: (Element | string)[] = [];
  style: Record<string, string> = {};
  append(...children: (Element | string)[]) {
    this.children.push(...children);
  }
  remove() {
    this.removed = true;
  }
}

test("spacecraft layer runs its clock, occludes by the body, and keeps tracks on a time grid", async (t) => {
  const { Scene, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } =
    await import("three/webgpu");
  const { createSpacecraftLayer, spacecraftVisible } =
    await import("../src/orbits/spacecraft-layer.ts");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: { createElement: () => new Element() },
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const radius = 6_378_137;
  assert.equal(spacecraftVisible(new Vector3(3 * radius, 0, 0), [2 * radius, 0, 0], radius), true);
  assert.equal(
    spacecraftVisible(new Vector3(3 * radius, 0, 0), [-2 * radius, 0, 0], radius),
    false,
  );
  // Behind the body's center plane, but the sightline clears the limb at 1.34 radii.
  assert.equal(
    spacecraftVisible(new Vector3(3 * radius, 0, 0), [-radius, 2 * radius, 0], radius),
    true,
  );

  const camera = new PerspectiveCamera(60, 2, 1, radius * 5);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.position.set(3 * radius, 0, 0);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  let requests = 0;
  const container = new Element();
  const context = {
    container,
    scene: new Scene(),
    overlay: new Scene(),
    camera,
    renderer: {},
    body: { name: "Earth", radiusMeters: radius },
    viewport: { width: 800, height: 400, pixelRatio: 1 },
    signal: new AbortController().signal,
    requestRender: () => requests++,
    reportError: (error: unknown) => {
      throw error;
    },
    sampleHeight: () => 0,
  } as unknown as import("../src/composition.ts").GlobeContext;
  const still = (id: string, x: number) => ({
    id,
    name: id,
    center: "EARTH",
    positionAt(_: number, out: { [index: number]: number }) {
      out[0] = x;
      out[1] = out[2] = 0;
      return true;
    },
  });
  // A GEO-like ring in the scene's equatorial plane, one revolution per 1000 s.
  const ring = {
    id: "ring",
    name: "Ring",
    center: "Earth",
    periodSeconds: 1000,
    positionAt(timeMs: number, out: { [index: number]: number }) {
      const angle = (timeMs / 1e6) * 2 * Math.PI;
      out[0] = 6.6 * radius * Math.cos(angle);
      out[1] = 0;
      out[2] = 6.6 * radius * Math.sin(angle);
      return true;
    },
  };
  const layer = createSpacecraftLayer(
    [still("near", 2 * radius), still("hidden", -2 * radius), ring],
    {
      timeMs: 0,
      rate: 10,
      trackSamples: 10,
    },
  );
  assert.throws(() => createSpacecraftLayer([ring, ring]), /Duplicate/);
  assert.throws(() => createSpacecraftLayer([ring], { trackSamples: 1 }), /samples/);
  assert.throws(
    () => createSpacecraftLayer([{ ...ring, center: "Moon" }]).attach(context),
    /orbits Moon, not Earth/,
  );
  layer.attach(context);
  const root = container.children[0] as Element;
  const [near, hidden] = root.children as Element[];
  assert.equal(near.dataset.spacecraftId, "near");
  assert.equal(near.children[1], "near");
  const frame = (now: number) =>
    ({
      context,
      now,
      deltaSeconds: 0,
      elapsedSeconds: 0,
    }) as import("../src/composition.ts").GlobeFrame;
  layer.update(frame(0));
  assert.equal(near.hidden, false);
  assert.equal(near.style.translate, "400px 200px");
  assert.equal(hidden.hidden, true);
  assert.ok(camera.far >= 3 * radius + 6.6 * radius - 1, "far plane covers the ring");

  assert.equal(context.scene.children.length, 0); // tracks sit above atmosphere and clouds
  const line = context.overlay.children[0].getObjectByName(
    "Spacecraft track · Ring",
  ) as import("three/webgpu").Mesh & {
    geometry: import("three/webgpu").InstancedBufferGeometry;
  };
  const segments = (
    line.geometry.attributes.instanceStart as import("three/webgpu").InterleavedBufferAttribute
  ).data.array as Float32Array;
  const fades = (
    line.geometry.attributes.instanceFadeStart as import("three/webgpu").InterleavedBufferAttribute
  ).data.array as Float32Array;
  // Viewed from 3.6 radii, ten 36° chords would visibly cut the ring; they are subdivided
  // until no chord sags more than half a pixel (here 0.5 × 60° / 400 px) from the curve.
  const tolerance = (0.5 * Math.PI) / 3 / 400;
  const vertices = (array: Float32Array, count: number) =>
    Array.from({ length: count + 1 }, (_, i) => {
      const j = i < count ? i * 6 : (count - 1) * 6 + 3;
      return [array[j] + 3 * radius, array[j + 1], array[j + 2]];
    });
  const count = line.geometry.instanceCount;
  assert.ok(count > 10, `${count} segments`);
  const drawn = vertices(segments, count);
  for (const [x, y, z] of drawn) {
    // Float32 camera-relative vertices 23,000 km away round to about 2 m.
    assert.ok(Math.abs(Math.hypot(x, y, z) - 6.6 * radius) < 4, "every vertex lies on the orbit");
    assert.equal(y, 0);
  }
  for (let i = 0; i < count; i++) {
    const [a, b] = [drawn[i], drawn[i + 1]];
    const chord = Math.hypot(a[0] - b[0], a[2] - b[2]);
    const sag = 6.6 * radius - Math.sqrt((6.6 * radius) ** 2 - (chord / 2) ** 2);
    const distance = Math.min(
      Math.hypot(a[0] - 3 * radius, a[2]),
      Math.hypot(b[0] - 3 * radius, b[2]),
    );
    assert.ok(sag <= tolerance * distance * 1.01, `segment ${i} sags ${sag} m at ${distance} m`);
  }
  assert.ok(fades[0] < 0.1, "the tail fades out");
  assert.ok(fades[count * 2 - 1] > 0.85, "the head is bright");
  // Tracks are rebased on the camera: vertices are camera-relative, so float32 stays exact
  // near the viewer. The head is the ring's t = 0 point, (6.6R, 0, 0), seen from (3R, 0, 0).
  assert.ok(context.overlay.children[0].position.equals(camera.position));
  assert.ok(Math.abs(segments[(count - 1) * 6 + 3] - 3.6 * radius) < 1);
  assert.ok(Math.abs(segments[(count - 1) * 6 + 5]) < 1e-6);
  // 1 s later at 10× (one twentieth of a grid step): grid and refined vertices stay put;
  // only the moving ends and their nearest subdivisions change.
  const before = new Set(drawn.slice(1, -1).map((v) => v.join()));
  layer.update(frame(1000));
  assert.equal(layer.getTimeMs(), 10_000);
  const after = vertices(segments, line.geometry.instanceCount).slice(1, -1);
  const kept = after.filter((v) => before.has(v.join())).length;
  assert.ok(kept >= after.length * 0.8, `${kept} of ${after.length} vertices kept`);
  assert.ok(requests > 0);

  layer.setRate(0);
  requests = 0;
  layer.update(frame(5000));
  assert.equal(layer.getTimeMs(), 10_000);
  assert.equal(requests, 0);
  layer.setTimeMs(500_000);
  layer.setTracksVisible(false);
  layer.setSpacecraftVisible("near", false);
  layer.update(frame(6000));
  assert.equal(line.visible, false);
  assert.equal(near.hidden, true);
  assert.throws(() => layer.setSpacecraftVisible("missing", true), /Unknown/);

  layer.dispose();
  layer.dispose();
  assert.equal(root.removed, true);
  assert.equal(context.overlay.children.length, 0);
});

test("subsolar points match equinoxes and solstices on Earth and Mars", async () => {
  const { subsolarPoint } = await import("../src/orbits/sun-position.ts");
  const near = (actual: number, expected: number, tolerance: number) =>
    assert.ok(Math.abs(actual - expected) < tolerance, `${actual} vs ${expected}`);
  // 2026 March equinox, 14:46 UTC; the equation of time is −7.4 minutes.
  const equinox = subsolarPoint("Earth", Date.UTC(2026, 2, 20, 14, 46));
  near(equinox.latitudeDeg, 0, 0.02);
  near(equinox.longitudeDeg, -15 * (14 + 46 / 60 - 7.4 / 60 - 12), 0.15);
  near(subsolarPoint("Earth", Date.UTC(2026, 5, 21, 8, 24)).latitudeDeg, 23.436, 0.01);
  near(subsolarPoint("EARTH", Date.UTC(2026, 11, 21, 20, 50)).latitudeDeg, -23.436, 0.01);
  // Mars year 38 began (Ls 0) on 2024-11-12; Ls 90 followed on 2025-05-29.
  near(subsolarPoint("Mars", Date.UTC(2024, 10, 12)).latitudeDeg, 0, 0.3);
  near(subsolarPoint("Mars", Date.UTC(2025, 4, 29)).latitudeDeg, 25.19, 0.1);
  // The Moon's equator is within 1.54° of the ecliptic.
  for (let day = 0; day < 400; day += 13)
    assert.ok(
      Math.abs(subsolarPoint("Moon", Date.UTC(2026, 0, 1) + day * 86_400_000).latitudeDeg) < 1.7,
    );
  assert.throws(() => subsolarPoint("Venus", 0), /No solar ephemeris/);
});

test("inertial states rotate into the same fixed positions, for TLEs and inertial OEMs only", () => {
  const [tle] = parseTle(`${LINE1}\n${LINE2}`);
  const { text, start } = circularOem({
    radius: 7_000_000,
    stepSeconds: 60,
    count: 40,
    frame: "EME2000",
  });
  const [oem] = parseOem(text);
  for (const [ephemeris, at] of [
    [tle, Date.UTC(2000, 5, 27, 18, 50)],
    [oem, start + 601_500],
  ] as const) {
    const inertial = [0, 0, 0],
      velocity = [0, 0, 0],
      fixed = [0, 0, 0],
      m = new Float64Array(9);
    assert.ok(ephemeris.inertialStateAt!(at, inertial, velocity));
    assert.ok(ephemeris.inertialToFixed!(at, m));
    assert.ok(ephemeris.positionAt(at, fixed));
    for (let r = 0; r < 3; r++) {
      const rotated =
        m[r * 3] * inertial[0] + m[r * 3 + 1] * inertial[1] + m[r * 3 + 2] * inertial[2];
      assert.ok(Math.abs(rotated - fixed[r]) < 1e-3, `${ephemeris.id} axis ${r}`);
    }
    assert.ok(Math.hypot(...velocity) > 3000);
    assert.ok(ephemeris.mu! > 3.9e14);
  }
  // The synthetic orbit's speed is √(μ/r); interpolated velocity matches it.
  const v = [0, 0, 0];
  oem.inertialStateAt!(start + 601_500, [0, 0, 0], v);
  assert.ok(Math.abs(Math.hypot(...v) - Math.sqrt(MU / 7e6)) < 0.01);
  const itrf = circularOem({ radius: 7_000_000, stepSeconds: 60, count: 40, frame: "ITRF2014" });
  assert.equal(parseOem(itrf.text)[0].inertialStateAt, undefined);
});

test("osculating elements recover a known ellipse", async () => {
  const { osculatingElements } = await import("../src/orbits/spacecraft-layer.ts");
  // Periapsis 7000 km on +x, e = 0.1, in the x–z plane.
  const rp = 7e6,
    e = 0.1,
    a = rp / (1 - e);
  const vp = Math.sqrt((MU * (1 + e)) / rp);
  const elements = osculatingElements([rp, 0, 0], [0, 0, vp], MU)!;
  assert.ok(Math.abs(elements.a - a) < 1e-3);
  assert.ok(Math.abs(elements.e - e) < 1e-12);
  assert.deepEqual(
    elements.p.map((x) => Math.round(x * 1e9) / 1e9 + 0),
    [1, 0, 0],
  );
  assert.deepEqual(
    elements.q.map((x) => Math.round(x * 1e9) / 1e9 + 0),
    [0, 0, 1],
  );
  assert.equal(osculatingElements([rp, 0, 0], [0, 0, vp * 2], MU), undefined); // escape
});

test("inertial tracks stay closed on a spinning body; osculating and ground lines follow", async (t) => {
  const { Scene, PerspectiveCamera, WebGPUCoordinateSystem } = await import("three/webgpu");
  const { createSpacecraftLayer } = await import("../src/orbits/spacecraft-layer.ts");
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    value: { createElement: () => new Element() },
    configurable: true,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const R = 6_378_137,
    r = 7e6,
    period = 6000, // seconds
    spin = TAU_TEST / 2400; // 2.5 body turns per orbit: a fixed-frame path ends opposite its start
  // Equatorial circular orbit; the body rotates about scene +Y.
  const inertialAt = (ms: number, out: { [i: number]: number }, v?: { [i: number]: number }) => {
    const angle = (TAU_TEST * ms) / 1000 / period,
      w = TAU_TEST / period;
    out[0] = r * Math.cos(angle);
    out[1] = 0;
    out[2] = -r * Math.sin(angle);
    if (v) {
      v[0] = -r * w * Math.sin(angle);
      v[1] = 0;
      v[2] = -r * w * Math.cos(angle);
    }
    return true;
  };
  const toFixed = (ms: number, m: { [i: number]: number }) => {
    const c = Math.cos((-spin * ms) / 1000),
      s = Math.sin((-spin * ms) / 1000);
    [m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]] = [c, 0, s, 0, 1, 0, -s, 0, c];
    return true;
  };
  const ephemeris = {
    id: "sat",
    name: "Sat",
    center: "Earth",
    periodSeconds: period,
    mu: r ** 3 * (TAU_TEST / period) ** 2,
    inertialStateAt: inertialAt,
    inertialToFixed: toFixed,
    positionAt(ms: number, out: { [i: number]: number }) {
      const p = [0, 0, 0],
        m = new Float64Array(9);
      inertialAt(ms, p);
      toFixed(ms, m);
      for (let i = 0; i < 3; i++)
        out[i] = m[i * 3] * p[0] + m[i * 3 + 1] * p[1] + m[i * 3 + 2] * p[2];
      return true;
    },
  };
  const camera = new PerspectiveCamera(60, 2, 1, R * 50);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.position.set(0, 4 * r, 0); // above the pole, looking down on the orbit plane
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const context = {
    container: new Element(),
    scene: new Scene(),
    overlay: new Scene(),
    camera,
    renderer: {},
    body: { name: "Earth", radiusMeters: R },
    viewport: { width: 800, height: 400, pixelRatio: 1 },
    signal: new AbortController().signal,
    requestRender: () => {},
    reportError: (error: unknown) => {
      throw error;
    },
    sampleHeight: () => 0,
  } as unknown as import("../src/composition.ts").GlobeContext;
  const layer = createSpacecraftLayer([ephemeris], {
    timeMs: 5_000_000,
    rate: 0,
    osculating: true,
    groundTrack: true,
  });
  layer.attach(context);
  const frame = {
    context,
    now: 0,
    deltaSeconds: 0,
    elapsedSeconds: 0,
  } as import("../src/composition.ts").GlobeFrame;
  layer.update(frame);
  const vertices = (name: string) => {
    const line = context.overlay.children[0].getObjectByName(name) as unknown as {
      visible: boolean;
      geometry: {
        instanceCount: number;
        attributes: Record<string, { data: { array: Float32Array } }>;
      };
    };
    const array = line.geometry.attributes.instanceStart.data.array;
    return {
      visible: line.visible,
      points: Array.from({ length: line.geometry.instanceCount }, (_, i) => [
        array[i * 6] + camera.position.x,
        array[i * 6 + 1] + camera.position.y,
        array[i * 6 + 2] + camera.position.z,
      ]),
    };
  };
  const radii = (points: number[][]) => points.map(([x, y, z]) => Math.hypot(x, y, z));
  // Inertial: a full orbit, all on the circle, and the loop closes (start ≈ end).
  const inertial = vertices("Spacecraft track · Sat");
  assert.ok(inertial.visible);
  for (const value of radii(inertial.points)) assert.ok(Math.abs(value - r) < 30);
  const first = inertial.points[0],
    last = inertial.points.at(-1)!;
  assert.ok(
    Math.hypot(first[0] - last[0], first[2] - last[2]) < 0.05 * r,
    "one period closes the loop",
  );
  // Osculating ellipse: the same circle.
  const osculating = vertices("Osculating orbit · Sat");
  assert.ok(osculating.visible && osculating.points.length > 90);
  for (const value of radii(osculating.points)) assert.ok(Math.abs(value - r) < 30);
  // Ground track on the surface.
  const ground = vertices("Ground track · Sat");
  assert.ok(ground.visible);
  for (const value of radii(ground.points)) assert.ok(Math.abs(value - R) < 30);
  // Fixed frame: the body turned 2.5 times under one orbit, so the path does not close.
  layer.setTrackFrame("fixed");
  layer.update(frame);
  const fixed = vertices("Spacecraft track · Sat");
  const f0 = fixed.points[0],
    f1 = fixed.points.at(-1)!;
  assert.ok(Math.hypot(f0[0] - f1[0], f0[2] - f1[2]) > 0.5 * r, "fixed-frame path does not close");
  layer.setOsculatingVisible(false);
  layer.setGroundTrackVisible(false);
  layer.update(frame);
  assert.equal(vertices("Osculating orbit · Sat").visible, false);
  assert.equal(vertices("Ground track · Sat").visible, false);
  assert.throws(() => layer.setTrackFrame("helio" as "fixed"), /Unknown frame/);
  layer.dispose();
});

const TAU_TEST = 2 * Math.PI;
