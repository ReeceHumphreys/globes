# Library guide

From a local build, install the npm tarball produced by `npm pack`, plus
`three@^0.186.1`. ESM and TypeScript declarations are included, and the build
inlines its WGSL, so no raw-shader plugin is needed. three.js is external to the
bundle; use one installation.

## TiledGlobe

```ts
const moon = new TiledGlobe({
  name: "Moon", // optional; manifests for another body are then rejected
  radius: 1_737_400, // equatorial
  overview: "/moon-2k.jpg", // equirectangular sRGB image, or a Texture (ownership transfers)
  imagery: "/data/moon/wac/manifest.json",
  regions: "/data/moon/apollo/catalog.json", // sparse high-resolution imagery
  elevation: "/data/moon/elevation-tiles/manifest.json",
  sun: directionalLight, // or a PointLight; its direction shades the terrain
  hapke: true,
});
scene.add(moon);
```

Every dataset is optional. Without imagery the globe draws its overview, and
without that, neutral terrain. URLs resolve against `document.baseURI`. Loading
starts in the constructor. `ready` settles once the initial imagery and
elevation setup has finished or failed; tiles keep streaming after that.

**Frame.** The globe's local frame is body-fixed: +Y north, +X longitude 0,
−Z longitude 90° east, in meters. Move or rotate the globe like any object, and
children ride the surface. Keep it unscaled: `radius` is in local meters.

**Per frame.** Call `globe.update(camera, renderer)` once before rendering. It
selects tiles for that camera, streams data and places labels. Rendering on
demand works too: the globe dispatches `change` whenever streaming or a fade
needs another frame, and when a setting changes.

**Settings** are plain properties, as on a material:

| Property         | Meaning                                                         |
| ---------------- | --------------------------------------------------------------- |
| `display`        | `"imagery"`, `"overview"`, `"terrain"` (neutral) or `"checker"` |
| `shading`        | Sun lighting; off shows unlit imagery                           |
| `terrainShadows` | Shadows cast by loaded elevation                                |
| `shadowSteps`    | Shadow ray-march steps, 8–48                                    |
| `displacement`   | Displace the surface by loaded elevation                        |
| `hapke`          | Lunar-style Hapke reflectance instead of Lambert                |
| `wireframe`      | Draw the tile grid                                              |

**Shape.** A globe is a sphere unless `flattening` is set, such as
`1 / 298.257223563` for WGS84 Earth. Latitudes are then geodetic and altitudes
are above the ellipsoid, so a point's direction from the center is no longer its
surface normal: use `normalAt` rather than normalizing a position.

**Queries.** `heightAt(normal)` returns the displayed terrain height above the
reference surface at a surface normal. `normalAt(point)` gives the normal beneath
a local point and `altitudeOf(point)` its height above the reference surface,
ignoring terrain. `positionAt(lat, lon, altitude)` returns a local point on the
terrain. `raycast` intersects the displayed surface, so
`raycaster.intersectObject(globe)` works.

**Errors.** Failed downloads are non-fatal. They are dispatched as `error`
events, or logged when nothing listens.

**Stats.** `globe.stats` holds the tile count, deepest level, selection time and
imagery/elevation status, much like `renderer.info`.

`dispose()` cancels downloads, releases GPU resources and removes the globe and
its labels.

## Atmosphere and clouds

```ts
earth.add(new Atmosphere(EARTH_AIR));
earth.add(new Clouds({ map: "/clouds.jpg" }));
```

Both are children of the globe, and `globe.update` drives them. `Clouds` is drawn
by the `Atmosphere`, so it needs one. It fades out below `fadeAltitudes` so it never
blocks an ascent. Call `dispose()` on each when finished.

## Overlays

```ts
earth.add(new Graticule({ parallels: [23.44, -23.44] }));
earth.add(new ImageOverlay({ map: "/coverage.png", opacity: 0.7 }));
earth.add(new SurfaceOverlay(({ uv, uvDx, uvDy }) => texture(map, uv).grad(uvDx, uvDy)));
```

Overlays are children of the globe and paint its surface, so they follow the terrain
at every zoom. `Graticule` picks its spacing from the camera's altitude unless given
`spacing`. `ImageOverlay` takes a north-up equirectangular image with alpha, or a
Texture: draw on a `CanvasTexture` and set `needsUpdate` for live data.
`SurfaceOverlay` takes a function that returns a TSL vec4 for a `SurfacePoint`.

`GeoJsonOverlay` takes a GeoJSON object or URL and reads all of RFC 7946. Lines and
polygon outlines are real lines: sharp and a constant width on screen. A position's
third value is its height above the ellipsoid, as the RFC defines it. Lines without
one lie on the ellipsoid, so they drift from the ground in steep terrain seen up close.
A step of more than 180° of longitude crosses the antimeridian, so data need not be
cut there. Polygon fills are painted on the surface at 10 km per pixel on Earth, and
ignore height. Points are `GlobeLabel`s, so they need a CSS2DRenderer; without a height
they sit on the terrain. One overlay has one style.

```ts
earth.add(new GeoJsonOverlay({ data: "/borders.geojson", color: "#fff", fill: "#f60" }));
```

Overlays are unlit, and they all lie under clouds and haze: hide `Clouds` when a map matters.
Adding or removing an overlay recompiles the terrain, so add them once, then toggle
`visible` or `opacity`.

## Bloom

```ts
const pipeline = createBloom(renderer, scene, camera);
pipeline.render(); // in place of renderer.render(scene, camera)
```

## GlobeControls

```ts
const controls = new GlobeControls(camera, renderer.domElement, moon);
controls.addEventListener("change", render); // optional, for on-demand rendering
// each frame: controls.update();
```

Left drag orbits, right drag or Shift-drag looks around, and the wheel and
pinch zoom toward the cursor. The camera is attached to the globe (keeping its
world transform) and stays above the displayed terrain. `update()` also fits the
near plane to the altitude and grows the far plane when needed. Call it before
`globe.update()`.

- `goTo(latitudeDeg, longitudeDeg, altitude)` looks straight down at a place.
- `altitude` reads or sets the height above the terrain.
- `minAltitude` (default 10 m) is the closest approach.

## Labels

`new GlobeLabel(element, latitude, longitude, altitude?)` is a three.js
`CSS2DObject`. Add it to the globe, directly or in untransformed groups, and draw
with `CSS2DRenderer`. Each `globe.update` places it on the terrain and hides it
behind the horizon or behind the camera. Its `visible` flag is managed by the
globe, so hide labels by hiding a parent group.

`geographicToDirection(latitude, longitude)` gives the local unit vector of a
geographic position, for placing your own objects.

## Rendering budgets and limitations

The resident slots bound GPU memory independently of quadtree depth. Each cache
allows 6–255 slots; terrain capacity limits drawn instances. Parents remain
available while visible refinements load. Existing grids, instance buffers, and
materials are reused. Selection runs on the CPU; each height tile's manifest
range supplies its conservative elevation bounds. Lighting defaults to Lambert; the Moon example opts into its lunar-style
Hapke visualization preset. It is not a scientifically fitted Mars/Earth BRDF.

Only spheres, flattened spheres and the normalized-cube tile format are supported.
This is not a GIS engine. Elevation heights are read as relative to the globe's
reference surface, with no geoid or areoid conversion. Version 1
elevation is fixed at 0.5 m units with −10000 m offset, allowing −10000 through
+22767.5 m. Some Earth bathymetry falls outside this range; the Earth relief command clamps those samples, and the shared encoder still rejects them. NoData fill, vertical
units, reprojection, and photometric correction require explicit preprocessing.
