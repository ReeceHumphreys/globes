# Compose a planet

The library separates the rendering engine, the surface, and optional scene
layers. A planet is a composition of these components, rather than a switch on
its name. The core imports no Moon assets, catalogs, sky maps, or lander models.

| Component                      | Responsibility                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Engine (`createGlobe`)         | WebGPU renderer, body-centered camera and input, viewport, exposure, Sun state, frame scheduling, lifecycle          |
| Surface (`GlobeSurface`)       | Own geometry/materials, optional height sampling and stats; the sole surface implementation for this globe           |
| Tiled surface (`tiledSurface`) | Quadtree, LOD, instanced grid, imagery/elevation caches, displacement, terrain shading                               |
| Scene layer (`GlobeLayer`)     | An optional scene contribution with its own shaders and owned resources: sky, Sun, models, rings, clouds, atmosphere |
| Application                    | UI, marker catalog, dataset choices, and the chosen composition                                                      |

The Moon example selects `tiledSurface({ hapke: true, ... })` and registers
`moonSkyLayer()`, `createSunLayer()`, and `apolloLayer()`, plus the generic `createMarkerLayer()` populated with Moon places. Those components read one
Sun direction. `globe.setSun(longitude, latitude)` now updates terrain, Sun, and
landers together. The UI no longer coordinates three separate light setters. Marker projection,
visibility, and DOM ownership live in the library; mission metadata and country
flags stay in the example. See [markers](markers.md).

Earth/Mars terrain can use a different configuration of the same tiled surface.
Atmosphere, clouds, oceans, and rings need their own implementations; this
migration provides their attachment points, not those physical models. A gas
giant can supply a custom surface and avoid creating terrain grids, selecting
tiles, loading manifests, or initializing elevation bounds.

## Shared context and frame

`attach(context)` receives a `GlobeContext` with these stable shared references:

- `container`: the positioned host element for DOM overlays such as markers.
- `body`: frozen name and spherical radius in meters.
- `scene`, `camera`, `renderer`: the shared Three.js objects.
- `overlay`: a scene drawn after `scene` and any compositor, with cleared depth and no
  tone mapping or color conversion (materials output sRGB). Use it for orbital
  annotations that atmosphere and clouds must not cover; occlude against the body
  in the material.
- `sun`: direction **toward** the light, longitude/latitude in degrees. Its unit
  direction vector changes in place; treat it as read-only.
- `viewport`: CSS width/height and device pixel ratio, updated on resize.
- `sampleHeight(x,y,z)`: displayed surface height along a body-centered direction;
  zero when the surface does not supply height. It includes streamed fallback.
- `requestRender()`: coalesced request for another frame.
- `signal`: aborted on this component's removal or globe disposal.
- `reportError(error)`: forwards an optional loading failure to `onError`.

`update(frame)` gets that component's context plus `now` (monotonic milliseconds),
`deltaSeconds` (time since the previous rendered frame, initially zero), and
`elapsedSeconds`. These are rendering times, not an astronomical clock or
reference-frame/ephemeris model. A layer that animates should call
`context.requestRender()` while animation is active. Frames otherwise run on
demand, including streaming fades.

Coordinates are body-fixed: +Y north, +X longitude zero, −Z longitude 90° east.
Geometry, camera distances, heights, and layer dimensions use meters. The
camera's orientation is still owned by orbit input. For small objects near the
surface, use a CPU-computed camera-relative anchor as the Apollo layer does;
subtracting large coordinates in a float shader loses precision. Moving the
whole planet to an astronomical scene position is not supported yet.

## Lifecycle and ownership

A component implements:

```ts
interface GlobeLayer {
  readonly id: string;
  attach(context: GlobeContext): void | Promise<void>;
  update(frame: GlobeFrame): void;
  dispose(): void;
}
```

Allocate resources in `attach`, not in the factory. Use a fresh component instance
per globe; an instance cannot be attached again, even after removal. IDs must be
unique within one globe, including the surface ID.

Initial attachment runs in order: surface, then `layers`. All attachments finish
before the first render; the surface updates first and scene layers follow in
insertion order. The engine performs one shared `renderer.render` after updates
and `onFrame` listeners. Layers add objects to the scene; they do not call the
renderer themselves. Depth testing, transparency, and object `renderOrder`
determine draw order, rather than layer array order. Manage render state through
Three.js materials. Shared exposure/tone mapping belongs to the engine.

For a large optional texture/model, start loading inside a synchronous `attach`
and request a frame on completion. Honor `signal`: abort fetches and dispose late
textures if a loader cannot cancel. Returning an attachment promise intentionally
holds startup until that promise settles. This does not give the engine a way
to cancel an uncooperative loader.

`await globe.addLayer(layer)` registers a layer dynamically. `removeLayer(id)`
removes it, aborts its signal, disposes its resources, and requests a frame. A
pending attachment is cleaned up when it settles and never receives updates
after removal. Failed attachment releases partial resources. Globe disposal
cleans up registered components in reverse order before disposing the renderer.
The surface cannot be removed independently; create another globe to replace it.
Do not separately dispose registered components from the application.

Layers own the objects/materials/textures they create. Remove their objects and
release those resources in `dispose`, including shared textures only once. If a
layer changes scene background/environment, restore previous values only if its
own value is still active. Use the Moon sky layer as an example.

This scene-layer contract does not implement a multipass compositor. An
atmosphere needing scene-color/depth textures or a custom postprocessing graph
will require an explicit rendering-pass API later; ordinary mesh/shell shaders
can already be scene layers. Rings also need a model for shadows on the planet;
adding a ring mesh alone does not supply that lighting interaction.

## Replace the surface

`GlobeSurface` extends the same lifecycle with optional `sampleHeight`, `stats`,
`ready`, and `prepare(now)`. `prepare` runs before camera clearance checks; the
tiled surface uses it to advance height blending. `ready` can represent optional
initial data setup; the engine exposes it as `globe.ready`.

Here is a minimal custom surface to demonstrate the boundary. Its material can
later be replaced with a procedural gas-giant shader. This example is a colored
sphere, not a Saturn atmosphere simulation.

```ts
import * as THREE from "three/webgpu";
import { createGlobe, createSunLayer, type GlobeSurface } from "tiled-globe";

function coloredSphere(): GlobeSurface {
  let mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicNodeMaterial>;
  return {
    id: "gas-surface",
    attach({ body, scene }) {
      mesh = new THREE.Mesh(
        new THREE.SphereGeometry(body.radiusMeters, 96, 64),
        new THREE.MeshBasicNodeMaterial({ color: 0xc5ad86 }),
      );
      scene.add(mesh);
    },
    update({ context }) {
      // A custom WGSL/node material can consume context.sun.direction here.
    },
    dispose() {
      mesh?.removeFromParent();
      mesh?.geometry.dispose();
      mesh?.material.dispose();
    },
  };
}

const globe = await createGlobe({
  container: document.querySelector<HTMLDivElement>("#globe")!,
  body: { name: "Saturn", radiusMeters: 58_232_000 },
  surface: coloredSphere(),
  layers: [createSunLayer()], // add your rings/atmosphere components here
});
```

Terrain-specific setters live on the `TiledSurface` returned by `tiledSurface()`.
The existing `globe.setHapke`, `setSurfaceLayer`, etc. delegate to surface
capabilities for compatibility; they throw if the selected custom surface does
not implement that operation. Sun/exposure/camera controls remain generic.

The body model is still spherical. Earth ellipsoids/datums, Saturn oblateness,
multiple scattering, eclipses, astronomical time, and per-body solar irradiance
are separate features; the new composition boundary leaves room for them.

The example's shared `createStarSkyLayer()` lives in
`examples/shared/star-sky.ts`; Earth, Mars, and Moon all use it. It owns the sky
texture and restores the previous background on disposal. Lunar models remain
in the Moon composition.

`createSunLayer({ angularDiameterDegrees: 0.35 })` configures the approximate
apparent Sun size for Mars; the default is 0.533 degrees for Earth/Moon. This
changes the disk size, not a physical solar irradiance model. Each layer reads
the globe's shared Sun direction, and `setFlareEnabled()` controls its optical
flare. Terrain lighting is supplied by the surface, not a Three.js light.

## Optional render pipeline and terrain lighting

`createGlobe({ renderPipeline: context => compositor })` accepts an owned
`{ render(), dispose() }` compositor. The engine prepares terrain, camera, and
scene layers before calling it. It is disposed before scene layers and renderer.
Omitting it keeps direct scene rendering.

`tiledSurface({ lighting: inputs => colorNode })` customizes surface lighting
without replacing terrain. `inputs` contains unlit linear RGB `color`, the
previous shaded `fallback`, body-fixed `normal` and `position` in meters,
`sunlight` visibility, and shading `enabled`. The adapter should honor enabled
and debug modes. These are GPU nodes, not CPU values.

The [experimental atmosphere adapter](experimental-atmosphere.md) uses both hooks
and keeps its third-party dependency outside the npm library.

For shared terrain/model lighting and a provider-owned compositor, prefer
[GlobeEnvironment](environments.md) over wiring separate callbacks in the app.
