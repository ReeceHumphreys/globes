# Library usage

## Install and mount

From a local build, install the npm tarball produced by `npm pack`, plus
`three@^0.186.1`. Node 24+ is required to build the repository. Runtime rendering
happens in the browser. ESM and TypeScript declarations
are included; the published build contains the WGSL and Wasm asset, so consumers
need no special raw-shader plugin or Wasm copy step. Use one compatible Three.js
installation; it is external to the library bundle.

```html
<div id="globe" style="width:100%;height:100vh"></div>
```

```ts
import { createGlobe, tiledSurface } from "tiled-globe";

const globe = await createGlobe({
  container: document.querySelector<HTMLDivElement>("#globe")!,
  body: { name: "Mars", radiusMeters: 3_389_500 },
  surface: tiledSurface({
    overview: "/data/mars/overview.jpg",
    imagery: "/data/mars/imagery/manifest.json",
    regions: "/data/mars/regions/catalog.json", // optional sparse imagery
    elevation: {
      tiles: "/data/mars/elevation-tiles/manifest.json",
      global: "/data/mars/elevation/manifest.json", // optional fallback
    },
    imagerySlots: 128,
    heightSlots: 64,
    tileCapacity: 2048,
    gridSegments: 32,
    maxLevel: 20,
    maxCellPixels: 12,
    hapke: false,
  }),
  minAltitudeMeters: 10,
  exposureStops: 0,
  onError: console.warn,
});

const unsubscribe = globe.onFrame((stats) => {
  console.log(stats.altitudeMeters, stats.tiles, stats.imageryStatus);
});

globe.goTo(-4.5, 137.4, 10000); // latitude, east longitude, altitude above terrain
// On unmount:
// unsubscribe(); globe.dispose();
```

`body` and `container` are required; every dataset URL is optional. Without a
texture the default tiled surface draws neutral terrain. `overview` is an equirectangular sRGB
image URL, or a Three.js texture whose ownership transfers to the globe.
Dataset URLs resolve against `document.baseURI`, including on subpath deployments.
Manifest body names and reference radii must match the configured body. A missing
(404) imagery manifest falls back to the overview; malformed or incompatible
imagery fails initialization. Optional elevation failures are reported and keep
the imagery usable.

Initial creation initializes the GPU, attaches the surface, then attaches scene
layers. The tiled surface loads its overview/imagery manifest during attachment.
Optional elevation starts with its first frame. `globe.ready` waits for that initial
elevation setup (or reported failure), not every future streamed tile. Regional
imagery setup runs independently. Rendering is on demand, including temporary
frames during tile fades. A `ResizeObserver` follows the container dimensions.

## Controls

- Left drag orbits; right drag/Shift-drag adjusts surface look direction.
- Wheel changes altitude above the loaded terrain.
- `setAltitude(meters)` and `goTo(latitudeDeg, longitudeDeg, altitudeMeters)` move
  the camera. All distances are meters and public geographic angles are degrees.
- `setSun(longitudeDeg, latitudeDeg)` sets the direction **toward** the light.
- `setExposure(stops)` uses a multiplier of `2 ** stops` before AgX tone mapping.
- `setSurfaceLayer("imagery" | "overview" | "terrain" | "checker")` selects a view.
- `setShading`, `setHapke`, `setTerrainShadows`, `setShadowSteps`, `setWireframe`,
  and `setElevationEnabled` update rendering. Boolean setters take a boolean;
  shadow steps are clamped to 8–48.
- `sampleHeight(x,y,z)` samples the currently displayed height in a body-centered
  direction; it returns zero when elevation is disabled or unavailable.
- `requestRender()` schedules one frame; `render()` renders immediately.
- `onFrame(callback)` runs before drawing so application-owned overlays can
  update. It returns an unsubscribe function.
- `dispose()` is idempotent, cancels requests/observers/input handlers and releases
  owned GPU resources. Registered surfaces/layers are disposed automatically;
  scene additions made outside that lifecycle need their own cleanup.

`surface` exposes the selected implementation; `context` exposes shared state.
`addLayer(layer)` asynchronously attaches an owned component; `removeLayer(id)`
aborts and removes it. The surface stays for the globe lifetime. See
[composition contracts and examples](composition.md). Existing top-level terrain
options remain accepted when `surface` is omitted. Do not mix them with an
explicit surface. The terrain display/lighting setters are compatibility
shorthands; a custom surface without that capability throws a clear error.

`scene`, `camera`, and `renderer` are exposed for composition. This engine assumes
its own body-centered camera; parented cameras and independently moving/scaled
planet objects are not supported. Custom camera changes need `requestRender()`.
Its own orbit orientation is reapplied during rendering. The coordinate frame is
+Y north, +X zero longitude, −Z 90° east. CPU camera-relative anchors preserve
surface precision without putting astronomical translations into GPU matrices.

## Rendering budgets and limitations

The resident slots bound GPU memory independently of quadtree depth. Each cache
allows 6–255 slots; terrain capacity limits drawn instances. Parents remain
available while visible refinements load. Existing grids, instance buffers, and
materials are reused. No compute-selection or Wasm selector is implied: the
optional small Wasm kernel builds conservative elevation bounds, with TypeScript
fallback. Lighting defaults to Lambert; the Moon example opts into its lunar-style
Hapke visualization preset. It is not a scientifically fitted Mars/Earth BRDF.

Only spherical bodies and the normalized-cube tile format are supported. This
is not an ellipsoid-aware GIS engine. Elevation heights must already be relative
to that sphere, rather than an unconverted geoid/areoid/ellipsoid datum. Version 1
elevation is fixed at 0.5 m units with −10000 m offset, allowing −10000 through
+22767.5 m. Some Earth bathymetry falls outside this range; the Earth relief command clamps those samples, and the shared encoder still rejects them. NoData fill, vertical
units, reprojection, and photometric correction require explicit preprocessing.

The exported pure `planCoverage(radiusMeters, detailCap, overviewCap?, minLevel?,
limit?)` helper plans sparse offline regions; unlike the Moon preset it requires
an explicit body radius. It does not allocate Three.js geometry or make requests.
