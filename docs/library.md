# Library guide

From a local build, install the npm tarball produced by `npm pack`, plus
`three@^0.186.1`. ESM and TypeScript declarations are included, and the build
inlines its WGSL, so no raw-shader plugin is needed. three.js is external to the
bundle; use one installation.

## TiledGlobe

```ts
const moon = new TiledGlobe({
  name: "Moon", // optional; manifests for another body are then rejected
  radius: 1_737_400,
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

**Queries.** `heightAt(direction)` returns the displayed terrain height above
the sphere along a local direction. `positionAt(lat, lon, altitude)` returns a
local point on the terrain. `raycast` intersects the displayed surface, so
`raycaster.intersectObject(globe)` works.

**Errors.** Failed downloads are non-fatal. They are dispatched as `error`
events, or logged when nothing listens.

**Stats.** `globe.stats` holds the tile count, deepest level, selection time and
imagery/elevation status, much like `renderer.info`.

`dispose()` cancels downloads, releases GPU resources and removes the globe and
its labels.

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

Only spherical bodies and the normalized-cube tile format are supported. This
is not an ellipsoid-aware GIS engine. Elevation heights must already be relative
to that sphere, rather than an unconverted geoid/areoid/ellipsoid datum. Version 1
elevation is fixed at 0.5 m units with −10000 m offset, allowing −10000 through
+22767.5 m. Some Earth bathymetry falls outside this range; the Earth relief command clamps those samples, and the shared encoder still rejects them. NoData fill, vertical
units, reprojection, and photometric correction require explicit preprocessing.
