# Design

## Thesis

A tight, high-performance globe component for three.js. It is the layer a GIS, a
Cesium-style app or an engineering tool builds on: from high-orbit views down to the
launch and landing of vehicles.

The globe does the work only a renderer can do: streaming the surface, precision,
lighting and compositing. Everything else belongs to the layer above it.

## The rule

For any feature, ask: **can it be built outside the library from what is public?**

- **Yes:** it stays out. Measurement, styling, reprojection, CZML, time-dynamic scenes,
  ground tracks, sensor footprints and widgets belong to the layer above.
- **No:** the core owes it, usually as an extension point rather than a feature.

## Principles

1. **Native three.js.** The globe is an `Object3D`. Overlays, atmosphere, labels and
   anchors are children added with `add`. The sun is the app's own `DirectionalLight`.
   A user who knows three.js should not have to learn a second scene model.
2. **Positions are exact. Pictures are approximate.** Queries return numbers an engineer
   can rely on, and `sampleHeight` says what a height is measured from and how fine the
   tile behind it is. Shading, atmosphere and water are real-time visualization, not a
   physical model.
3. **Body-fixed only.** Everything is in the body's fixed frame: latitude, longitude and
   height on a reference ellipsoid. Inertial frames, ephemerides, time scales and
   dynamics belong to the app, with small helpers on that edge such as `subsolarPoint`.
4. **Bodies are parameters.** Any sphere or flattened sphere, described by its radius
   and flattening. Earth, Moon and Mars are examples, not special cases.
5. **Standards in, not legacy.** Current standard formats are read directly, through
   adapters at the source seams. Nothing bends for formats kept alive only by history.
6. **Offline by default.** No hidden network calls and no default public data. Everything
   works air-gapped against our own tile server, or any server that meets the tile
   contract.

## Extension points

These are the public interface for the layer above. Each is stable once the library
reaches 1.0.

| Need                     | Extension point                                                             |
| ------------------------ | --------------------------------------------------------------------------- |
| Any imagery format       | `ImagerySource`: tiles by address. Datasets and WMTS are adapters.          |
| Any terrain format       | `HeightSource`: uint16 height tiles by address, with bounds.                |
| Drawing on the terrain   | `SurfaceOverlay`: a TSL shader per surface pixel, under haze.               |
| Objects near the surface | `GlobeAnchor`: a `Group` in local east-up-south metres.                     |
| Labels                   | `GlobeLabel`: a CSS2D object that follows terrain and hides at the horizon. |
| Picking                  | `raycaster.intersectObject(globe)`.                                         |
| Positions and heights    | `positionAt`, `heightAt`, `sampleHeight`, `normalAt`, `altitudeOf`.         |
| Lighting user objects    | The shared sun, and `atmosphere.sunlightAt(point)`.                         |
| Knowing when to render   | `change` and `loaded` events, and `stats`.                                  |
| 3D content on the ground | `TerrainMask`: hides the terrain inside a rectangle under a scan.           |

Sources address tiles on the tile contract's grid (`tile-service/spec`). An adapter for
another format reprojects into that grid; the globe draws one grid only.

## Precision

three.js renders in 32-bit floats, about half a metre at Earth's radius. To make one
scene work from the launch pad to high orbit:

- **Anchors.** Put things near the surface in a `GlobeAnchor`, not at Earth-centred
  positions. The globe places it on every update.
- **`renderer.highPrecision = true`.** three.js then forms model-view matrices in 64-bit
  on the CPU, so anchored objects stay stable to centimetres. The terrain is already
  drawn relative to the camera.
- **A reversed depth buffer**, so terrain and vehicles don't fight from orbit to surface.
- **Queries run in 64-bit JavaScript numbers.** Only rendering is limited to 32-bit.

## Scene integration

User objects share the globe's sun, and the atmosphere's haze composites over them by
depth. Multiply a light by `atmosphere.sunlightAt(point)` so a vehicle at sunset matches
the ground. The globe's own materials and shaders are internal: `SurfaceOverlay` is the
way to change what the surface shows.

## Close to the ground

The globe's terrain is the surface everywhere, from orbit to the launch pad. It never
hands over to another terrain at some zoom level: one altitude can't suit a tilted view,
and shadows, overlays, height queries and anchors would all stop at the handover. Detail
close in comes from two places:

1. **Finer heights near a site,** in the same height dataset: tile-service's
   `height-regions` blends a regional DEM, such as 1 m lidar around a pad, into the global
   pyramid, and the globe streams it like any other tile. Shadows and queries keep working.
2. **3D Tiles on top** where real 3D exists: pad structures, buildings, scans. They are
   streamed by [3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS), added
   to the globe as a child; the core doesn't depend on it. The core owes one hook,
   `TerrainMask`, which hides its terrain inside a rectangle so the ground doesn't show
   through a scan.

## Data

- **The tile contract** is the fast path, and the globe and our tile server stay
  decoupled behind it. Height tiles state their vertical datum. The globe does not
  convert between datums; on a flattened body it accepts only `ellipsoid`.
- **Other formats** are adapters at `ImagerySource` and `HeightSource`.

| Status | Formats                                                            |
| ------ | ------------------------------------------------------------------ |
| In     | PMTiles, WMTS, GeoJSON, glTF, 3D Tiles (through 3DTilesRendererJS) |
| Likely | Cloud Optimized GeoTIFF, MVT                                       |
| Out    | KML, Shapefile, CZML                                               |

## Performance

60 fps on a laptop with an integrated GPU. Desktop browsers are the supported class.
WebGPU only, with no WebGL fallback.

## Reproducibility

`loaded` fires when every tile in view has arrived and finished fading in, and
`stats.loaded` holds the same state. The frame rendered after that update is complete,
so report figures and regression images are reliable. Bit-identical frames across
machines are not a goal.

## Not in the core

These are layers others build on top, not things the globe refuses to support:

- **GIS:** reprojection between coordinate systems, datum transforms, feature queries,
  geometry operations, raster analysis, cartographic styling and editing.
- **A Cesium-style app:** time-dynamic scenes, CZML, widgets and default world data.
- **Simulation:** orbits, dynamics and time systems.
- **Irregular bodies:** asteroids and comets, until a real tool needs them.

## Audience

A public library for anyone building on a globe. Our own tools are the first users. The
API may change before 1.0, and this document changes with it.
