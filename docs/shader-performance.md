# Shader cleanup and compute candidates

The current rendering path remains one shared instanced grid. Terrain gradients
and sunlight use a compute dispatch in the viewer, with a shader fallback when
a tile is not cached. Tile and elevation formats are unchanged.

## Changes made

- The global relief-normal function calls the same bilinear elevation sampler
  as displacement. Longitude wrapping, pole handling, packed-height decoding,
  and pixel-center mapping now have one implementation.
- Height sampling returns before texture reads when elevation is disabled.
  Relief-normal sampling skips its height reads when shading is disabled or the
  checker view is active. Checker mode also bypasses the terrain ray march.
- Hapke runs only when shaded surface rendering is active. The fixed-parameter
  nadir/full-phase reference brightness is computed once on the CPU and passed
  as a uniform, rather than evaluating the full roughness function again for
  each fragment. Keep `rendering/hapke.ts` aligned with the shader's 20° preset
  if that preset changes or becomes configurable.
- Parent, child, overview, and neutral-terrain colors blend before a single
  lighting multiplication. This preserves their alpha/fade behavior.
- Reuse one WGSL function node for the three tile-to-face UV calls instead of
  generating renamed duplicate functions. Shader parameter names now say
  `overviewColor` and `tiledImageryEnabled`, rather than Moon-specific names.

These branches do not remove every unused texture sample. Three.js may evaluate
function arguments before entering a WGSL function. In particular, imagery
texture samples still belong to the shared material graph. Specialized material
variants could eliminate more work, at the cost of shader compilation/pipeline
switches; profile before adding them.

The generated pipeline was validated on an Apple M5 Pro through Metal with the
existing eight vertex-buffer bindings and sixteen attributes. A GPU compute
harness compared 65,536 sampled Hapke orientations before/after the reference
change: maximum absolute difference was 2.38e-7.

Correction: the previously reported 0.0233 → 0.0219 ms Hapke timing used a reused
native timestamp query that returned the preceding batch. That performance
comparison is withdrawn. Resolving queries only after the measured batch
completes fixes the issue; the corrected isolated run measures about 0.00866 ms
for each version, with no meaningful performance gain. The numerical comparison
is unaffected. See the [corrected raw results](../benchmarks/terrain-cache/results/hapke-corrected-apple-m5-pro.json).

The subsequent [terrain-cache investigation](terrain-cache-investigation.md)
uses the corrected method, actual downloaded height tiles, and a rerunnable
browser harness. It found useful kernel-level savings, plus a normal-transition
accuracy issue that requires a fallback. These remain prototypes outside the
viewer; no browser visual or whole-view frame-rate gain is claimed.

## Which work belongs in compute?

WebGPU compute can write buffers and storage textures for later rendering;
Three.js exposes compute dispatch and storage textures. These facilities make
reusable derived terrain data a better first experiment than moving every
calculation out of the draw shaders. See the [WebGPU specification](https://gpuweb.github.io/gpuweb/),
[Three.js Renderer](https://threejs.org/docs/pages/Renderer.html), and
[StorageTexture](https://threejs.org/docs/pages/StorageTexture.html).

These priorities are architectural judgments based on the current shader paths,
not measured bottleneck rankings:

| Candidate                          | Why it might help                                                                                                                                                                             | Cost and invalidation                                                                                                                                                                                                                                                      | Priority                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Cached elevation gradients         | Surface normals currently request four neighboring heights per shaded fragment, with up to two height layers during fades. Generate reusable height gradients when an elevation tile arrives. | Extra texture storage and a pass per updated tile. Gutters, cube-face edges, parent/fine blending, radius, and geometric metric must remain consistent. Reconstruct/blend slopes before normalizing; do not blindly blend final normals.                                   | First compute prototype                 |
| Cached terrain sunlight visibility | A cache miss ray-marches up to 48 height samples per vertex. A settled tile reuses one texel while the camera moves and the Sun stays put.                                                    | Cache depends on Sun, height-cache contents/coverage, tile level, sampling/feather settings, and transitions. Current feathering depends on mesh-cell size, so this is not a drop-in persistent per-tile texture. A cache must also retain spherical night-side occlusion. | Shipped, with a shader fallback         |
| GPU visibility/LOD and compaction  | Could select and pack very large tile sets without CPU submission work.                                                                                                                       | Streaming priorities still need CPU data. Readback defeats the benefit unless selection, compaction and indirect drawing form a GPU-resident pipeline. Existing tile budgets are bounded.                                                                                  | Only if selection profiling warrants it |
| Atmospheric lookup tables          | Reuse scattering tables for an eventual atmosphere layer.                                                                                                                                     | The planets example has an atmosphere. The published library does not bundle one.                                                                                                                                                                                          | Example only                            |
| Marker projection                  | Parallelizable arithmetic.                                                                                                                                                                    | Our catalog is small; DOM labels still need CPU positions. Readback and DOM work likely outweigh the savings.                                                                                                                                                              | Keep on CPU                             |
| Cube-to-sphere projection          | Already runs in the vertex shader on one reusable grid.                                                                                                                                       | Compute would add storage/write/read work without useful reuse for the current draw.                                                                                                                                                                                       | Keep in vertex stage                    |

The first prototypes have now been measured in the
[terrain-cache investigation](terrain-cache-investigation.md). Gradient and
sunlight caches are on by default in the viewer. They bake after their inputs
settle and fall back to the shaders on a miss. CPU camera clearance still needs
its CPU height samples; do not introduce synchronous readback into the render loop.
