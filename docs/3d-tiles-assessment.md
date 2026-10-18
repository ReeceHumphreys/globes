# 3DTilesRendererJS assessment

Reviewed NASA-AMMOS/3DTilesRendererJS and its upstream usage documentation.
No dependency or tileset download has been added by this assessment.

## Where it fits

The strongest fit is an optional `GlobeLayer` for prepared regional 3D Tiles:
Earth buildings/photogrammetry, Mars rover-site reconstructions, and detailed
lunar site meshes. This complements the global imagery/elevation surface.
An existing GLB such as our Apollo model does not need a tile renderer by itself.

The project handles hierarchical tile selection, asynchronous loading and
parsing, LRU caches and priority queues. Multiple renderers can share caches and
queues. Its examples include Mars terrain and third-party lunar/Mars services;
those examples do not imply that every dataset is free or unauthenticated.

It also offers map/terrain plugins. Those deserve separate experiments before
replacing our normalized-cube raster/elevation pipeline; their data addressing,
materials, and WebGPU compatibility differ from our current implementation.

## Adapter work required

An adapter would create a TilesRenderer, register our camera and viewport
resolution, add its group to the scene, update it after camera matrices are
current, and request renders when asynchronous content changes. It would own
and dispose event listeners, models, loaders, and custom material resources.

It must explicitly convert the tileset's coordinate frame and body definition.
Earth ECEF `(x,y,z)` maps to our body frame `(x,z,-y)`. Moon and Mars tilesets
need their own declared reference and units; Earth defaults must not be assumed.
Preserving precision near the ground may require rebasing or tile-local
transforms. This must be tested against the actual tileset, not inferred from a
successful orbit view.

Supported standard/PBR materials can use the shared globe environment's scene
lights and atmospheric compositor. Dataset images may already contain shadows;
relighting requires the same caution as our surface mosaics. Mixed meshes and
raster terrain may need cutouts or other coverage handling to avoid z-fighting.
Additional geometry does not automatically update our camera ground sampler.

Set explicit resident memory/queue budgets and coordinate them with our imagery
and elevation caches. A single application's total memory matters more than
several individually bounded caches. Visibility/load events should drive our
existing demand-render scheduler rather than introduce an always-on loop.

## WebGPU boundary

Core model rendering is promising, but support is not universal across plugins.
An open upstream report specifically identifies ShaderMaterial usage in the
imagery-overlay path as incompatible with WebGPURenderer. We should first test
one static mesh tileset with standard materials under our reversed-depth camera
and atmosphere before evaluating overlay/fade/point-cloud plugins individually.
No frame-rate or memory improvement is claimed without a representative test.

## Sources

- [Repository, features, examples and Apache-2.0 license](https://github.com/NASA-AMMOS/3DTilesRendererJS)
- [Usage: shared caches/queues, custom materials, render-on-change](https://github.com/NASA-AMMOS/3DTilesRendererJS/blob/master/USAGE.md)
- [WebGPU plugin/material compatibility report](https://github.com/NASA-AMMOS/3DTilesRendererJS/issues/1380)
