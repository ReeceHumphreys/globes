# Shared globe environments

A globe owns one optional `GlobeEnvironment`, available to every surface and
layer through `context.environment`. The engine attaches and updates it before
terrain and models, and disposes it after them. One instance owns the shared
lighting state and, optionally, the final compositor.

```ts
const environment = createMyEnvironment();
const globe = await createGlobe({
  container,
  body,
  environment,
  surface: tiledSurface({ imagery, elevation }),
  layers: [modelLayer],
});
```

The environment implements the ordinary `GlobeLayer` lifecycle plus:

- `lighting?: TerrainLighting`: a linear RGB lighting node used by tiled terrain.
  An explicit `tiledSurface({ lighting })` override takes precedence.
- `lightsModels?: boolean`: advertises that the environment supplies scene lights
  for standard/PBR model materials. Layers should omit their private Sun/fill
  lights when this is true. This does not force unlit materials to become lit.
- `createRenderPipeline?(context)`: supplies the final `{ render(), dispose() }`
  compositor. The engine prepares the camera and updates all scene layers before
  rendering it, then disposes it before scene layers during teardown.

Do not also supply `GlobeOptions.renderPipeline` when the environment owns one;
ambiguous compositor configuration is rejected. The environment cannot be
removed with `removeLayer`; dispose the globe to release it. Existing applications
without an environment retain their prior behavior.

## Current providers

`createSunEnvironment()` is the dependency-free airless model lighting provider.
It follows the globe's body-fixed Sun direction and supplies one directional and
one ambient light. Its defaults preserve the Moon example's previous model
lighting. Terrain retains its existing Lambert/Hapke shader. Options
`directIntensity` (default 3) and `ambientIntensity` (default 0.08) are nonnegative
Three.js lighting controls, not a calibrated physical irradiance model.

The example's `createPlanetAtmosphere()` implements the same contract using
Takram. Its attach step installs the per-renderer atmospheric context before
terrain or models compile. Terrain uses that context for direct and diffuse
light; standard/PBR model materials use Takram's `AtmosphereLight` and
`AtmosphereLightNode`, reading the same LUTs and Sun state. Toggling atmosphere
off switches model lights and terrain back to their fallback paths together.
Models do not need to import Takram. The renderer owns only its generic
provider interface; no Takram dependency is added to the npm library.

The atmosphere provider waits for all LUT stages before replacing fallback
lighting. Its compositor captures readable scene depth and applies attenuation
plus in-scattering to opaque terrain and models. Terrain lighting inputs include
a body-frame surface-to-camera `view` and `imageryEnabled` for material-specific
effects. The Earth example uses those for [ocean reflections](oceans.md), while
neutral terrain and checkerboard remain inspection modes.

Apollo models now use the shared airless environment instead of adding their own
lights. The standalone lander helper retains its private-light fallback for
existing callers.

## Boundaries

The environment shares lighting, not material semantics or geometry. Imported
models still need supported lit materials; custom GLSL materials do not become
WebGPU-compatible through this API. The atmospheric model light currently has
no terrain-shadow visibility input: terrain's cached ray-marched shadows are
not automatically applied to model surfaces, and model cast shadows require
separate shadow configuration. Atmospheric volume shadows are also not added.

Weather streaming is intentionally deferred until a dataset is integrated.
Cloud/dust fields should have their own geographic, vertical, temporal, and
memory budgets instead of following terrain subdivision. They can feed a
provider's atmospheric state and compositor through a future weather layer.
There is no empty weather cache or dependency-specific state in the core API.

See [atmosphere details](experimental-atmosphere.md) and
[3D Tiles integration assessment](3d-tiles-assessment.md).
