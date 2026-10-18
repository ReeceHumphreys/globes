# Orbiting spacecraft

Two sources turn orbit data into `OrbitEphemeris` objects. `createSpacecraftLayer()`
draws them as labels with tracks. An ephemeris returns a position in the globe's
body-fixed scene axes (meters, +Y north, +X longitude 0) for a given UTC
millisecond time, so applications can also use one without the layer.

```ts
import { createGlobe, createSpacecraftLayer, parseTle, tiledSurface } from "tiled-globe";

const tles = parseTle(await (await fetch("/data/stations.tle")).text());
const spacecraft = createSpacecraftLayer(tles, { rate: 60 });
const globe = await createGlobe({
  container: document.querySelector<HTMLDivElement>("#globe")!,
  body: { name: "Earth", radiusMeters: 6_378_137 },
  surface: tiledSurface({ overview: "/data/earth/overview.jpg" }),
  layers: [spacecraft],
});

spacecraft.setTimeMs(Date.UTC(2026, 9, 24));
spacecraft.setRate(0); // pause; also stops continuous rendering
```

## TLE

`parseTle(text)` accepts two-line sets, optionally with a name line before each one (including
CelesTrak's `0 NAME` form). It checks line checksums and catalog numbers, then
propagates each set with SGP4/SDP4 from [satellite.js](https://github.com/shashwatak/satellite-js)
(MIT). SGP4 output is in TEME and is rotated to Earth-fixed axes using
Greenwich mean sidereal time. The ephemeris `id` is the NORAD catalog number. A
TLE has no validity window, but its accuracy decays over days to weeks from the
element epoch. Decayed or invalid propagations return `false`.

## OEM

`parseOem(text, options?)` reads CCSDS Orbit Ephemeris Messages in KVN (text) form.
It returns one ephemeris per `OBJECT_ID`, with segments in file order, and uses
`USEABLE_START_TIME`/`USEABLE_STOP_TIME` when present. Outside every segment,
`positionAt` returns `false` and the layer hides the spacecraft. Supported
interpolation is `HERMITE` (positions and velocities), `LAGRANGE` and `LINEAR`, at
the file's `INTERPOLATION_DEGREE`. A missing method defaults to degree-5 Hermite.
Interpolation runs in the file's frame, before rotation. Covariance blocks are
skipped. XML OEMs and `REF_FRAME_EPOCH` are not supported.

Time systems UTC, TAI, GPS, TT and TDB are supported (TDB is treated as TT).

| Center | Built-in frames                                                               |
| ------ | ----------------------------------------------------------------------------- |
| Earth  | `ITRF*`, `GTOD`, `IAU_EARTH` (fixed); `TEME`; `EME2000`/`J2000`/`ICRF`/`GCRF` |
| Moon   | `MOON_ME`, `MOON_PA`, `IAU_MOON` (fixed); `EME2000`/`J2000`/`ICRF`            |
| Mars   | `IAU_MARS` (fixed); `EME2000`/`J2000`/`ICRF`                                  |

Earth's inertial frames use IAU-76 precession and IAU-82 sidereal time.
Nutation and polar motion are omitted. Against Vallado's FK5 worked example,
the result is within 0.14 km. The Moon and Mars use the IAU WGCCRE 2009
rotation models. `IAU_MOON` approximates the mean-Earth frame, and `MOON_PA`
is passed through unchanged, although it differs from `MOON_ME` by up to about
a kilometer. UT1 is taken as UTC and TAI−UTC is fixed at 37 s (correct since
2017). These approximations suit visualization, not precise orbit work. Pass
`frames: (center, frame) => transform` to supply any other rotation; it is
consulted before the built-in table.

Files fail loudly: an unknown frame, time system or interpolation, a missing
required keyword, decreasing epochs, or a usable span outside the records throws.

## Layer

`createSpacecraftLayer(ephemerides, options)` owns a simulation clock. It starts
at `timeMs` (the wall clock by default) and advances at `rate` simulated seconds
per real second (1 by default). While `rate` is nonzero, the layer requests a
frame every frame. On attach, it rejects any ephemeris whose `center` does not
match the globe body.

Each spacecraft gets a DOM label (a colored dot and its name, or
`createElement(ephemeris)`) and up to three lines:

- **True path:** spans `trailSeconds` behind (one period by default) and `leadSeconds`
  ahead, clipped to OEM coverage. With `trackFrame: "inertial"` (the default) it is drawn
  in a non-rotating frame centered on the body, so a closed orbit stays closed while the
  body turns. Vizard draws it this way. `"fixed"` draws the path over the rotating
  surface.
- **Osculating orbit** (`osculating: true`): the two-body ellipse from the current
  position, velocity and `mu`.
- **Ground track** (`groundTrack: true`): the fixed-frame path projected onto the
  reference sphere.

The inertial path and the osculating orbit need an ephemeris with `inertialStateAt`,
`inertialToFixed` and, for the ellipse, `mu`. TLEs (TEME) and OEMs in inertial frames
(EME2000, ICRF, GCRF, TEME) provide them. Other sources fall back to the fixed frame.
`setTrackFrame`, `setOsculatingVisible` and `setGroundTrackVisible` change the lines at
run time.

Lines start from a coarse grid with fixed times, so vertices do not slide as time
advances. A chord is then split at its parameter midpoint wherever its sag, seen from the
camera, would exceed half a pixel. The lines therefore stay smooth from planet scale down
to a few meters from a spacecraft. Vertices are written relative to the camera, and the
material computes its transform in float64, so lines do not jitter near a spacecraft.

Tracks are drawn in the globe's overlay pass, after the scene and any atmosphere or
cloud compositor. Haze and clouds therefore never wash them out or cover them. They
are antialiased screen-space ribbons (`trackWidth`, 3 CSS pixels by default) with a
soft dark halo for contrast over clouds and ice. Their opacity fades from the
spacecraft toward the tail, and the future (`leadSeconds`) is drawn dim. The overlay
has no scene depth, so each fragment is hidden in the shader when its sightline
crosses the body's reference sphere. Labels use the same sphere test. Terrain
occludes neither. The engine sizes the camera's far plane for the body alone. The
layer extends it in `update` so that GEO and cislunar tracks are not clipped.

Like markers, this layer is for tens of spacecraft, not catalogs of thousands.
Each label is a DOM node and each track is a draw call.

## Sun position

`subsolarPoint(center, timeMs)` returns the planetocentric latitude and east longitude
where the Sun is overhead, for `globe.setSun`. It works for Earth, the Moon and Mars.
It uses JPL's approximate Keplerian elements (valid 1800–2050), rotated by the frames
above. Earth and Mars are accurate to about 0.01°. The Moon uses the Earth–Moon
barycenter, which adds up to 0.15° of parallax. The library has no global clock, so
the application decides which time drives lighting:

```ts
globe.onFrame(() => {
  const sun = subsolarPoint("Earth", spacecraft.getTimeMs());
  globe.setSun(sun.longitudeDeg, sun.latitudeDeg);
});
```

To let terrain sunlight caches settle, avoid calling `setSun` for sub-0.1° changes.
The example's `sunFollowsClock` does this.

## Try it in the example

The Earth and Mars example accepts `?tle=<url>` or `?oem=<url>` (URL-encoded, and
served with CORS), plus an optional `&rate=` multiplier. For example,
`?body=earth&rate=30&tle=https%3A%2F%2Fcelestrak.org%2FNORAD%2Felements%2Fgp.php%3FGROUP%3Dstations%26FORMAT%3Dtle`.
When the current time lies outside an OEM's coverage, playback starts at the
beginning of the data. While spacecraft are loaded, the Sun follows their clock,
the manual Sun sliders are disabled, and the panel shows the simulation time.
