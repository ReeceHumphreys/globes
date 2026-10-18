# Terrain cache investigation — 2026-10-18

Both caches have useful kernel-level savings. Sunlight has the larger potential
saving; normals are the simpler integration. Neither is enabled in the viewer.
The experiments live under `benchmarks/terrain-cache`, outside the library.

## What was measured

On an Apple M5 Pro / Metal, the GPU executed the production height samplers,
normal calculation, sparse cross-face elevation lookup, solar occlusion, and
24-step terrain ray marcher, plus experimental cache-generation/lookup kernels.
Inputs are downloaded lunar height tiles, not a flat or analytic terrain fixture.

The fixture contains 21 layers including the empty slot: all six roots, a coarse
+X tile (`0/1/0/0`), and a fine south-polar tile near Shackleton
(`3/13/4080/4077`) with its resident ancestor chain. Core size is 128 samples with
two gutter samples on each side, giving 132×132 stored samples per tile.
This is a small, warm working set. It does not simulate the entire resident set
or streaming process.

Timings below are medians of 12 alternating-order samples, each containing 256
repeated dispatches after warmup. GPU timestamps are resolved after measured work
completes. A separate completed-batch wall-clock check confirmed the fast/slow
ordering. Data upload, resource creation, compilation, JavaScript submission,
Three.js rendering, rasterization, other shaders, and presentation are excluded.
Both comparison paths write the same output buffer. Readback is for experiment
validation only, not a proposed viewer render-loop operation.

[Raw results, all timing samples, dataset addresses, and hashes](../benchmarks/terrain-cache/results/apple-m5-pro-metal.json)
record the executed shader source and height/index buffers. The shader code used
by the native GPU check is also used by the browser harness; the browser runner
itself has been type-checked and bundled, but was not run in a browser this turn.
A temporary external native GPU validation harness was used for the measured run;
no Python dependency or Python code is added to the project.

## Results

| Workload                                                        | Existing calculation | Cached lookup | Kernel speedup |
| --------------------------------------------------------------- | -------------------: | ------------: | -------------: |
| 262,144 normals, coarse tile                                    |           0.01859 ms |    0.00754 ms |          2.46× |
| 262,144 normals, south-polar tile                               |           0.01851 ms |    0.00755 ms |          2.45× |
| 1,089 sunlight samples, coarse tile, Sun 1° above local horizon |           0.02414 ms |    0.00171 ms |          14.1× |
| 1,089 sunlight samples, south-polar tile, Sun 1°                |           0.05744 ms |    0.00171 ms |          33.6× |
| 1,089 sunlight samples, south-polar tile, Sun 60°               |           0.06800 ms |    0.00170 ms |          40.1× |

The local Sun angles are relative to each patch, rather than geographic Sun
latitude. The coarse patch spans a broad region; its low-Sun sample includes
both lit and unlit values. All sampled polar locations were shadowed at 1° and
lit at 60°. This verifies reuse of the existing shadow algorithm, not its
physical accuracy or a permanently shadowed-region classification.

Night-side samples already exit the ray marcher early, so their absolute saving
is much smaller. See raw results for that case. Do not multiply these per-patch
times by the number of visible patches: occupancy, batching, and working-set size
change with a real scene. These numbers do not establish an FPS improvement.

### Normal cache: accuracy matters during transitions

The cache stores two central height differences in a filterable `rgba16float`
array texture. A later lookup reconstructs the normal using the same analytic
cube-sphere metric as the production shader. This avoids directly interpolating
unit normals. The format and write-only storage usage are supported by
[WebGPU's format capabilities](https://gpuweb.github.io/gpuweb/#texture-format-caps).

A 97×97 validation grid deliberately avoids alignment with the 128-sample height
grid. An earlier power-of-two grid masked the parent-transition error.

| State                                                      | Coarse maximum angular difference | Polar maximum angular difference |
| ---------------------------------------------------------- | --------------------------------: | -------------------------------: |
| Fully settled child                                        |                           0.0357° |                          0.0348° |
| 50% parent/child blend using cached slopes                 |                             3.32° |                            2.47° |
| Parent-only height with the child's finer sampling stencil |                             6.64° |                            4.91° |

The existing code takes a finite difference of blended heights at the child's
sampling distance. A parent's cached slope was measured at a larger distance;
rescaling it cannot reproduce that operation exactly around changes in slope.
Half-float storage/filter interpolation also introduces the small settled error.

A tested hybrid uses the existing normal function while `transition < 1`, and
cached gradients once settled. Its angular error during the tested transitions
is zero; at a settled child it retains the <0.036° difference. During a 50% fade,
the hybrid costs about 0.0349 ms versus 0.0347 ms for the original: it preserves
quality and does not claim a speedup while fading.

Building gradients for all 21 fixture layers costs 0.01173 ms of GPU kernel time.
The actual viewer's 65 height slots at 132×132 would require about **8.64 MiB**
extra for this format, four times the packed height array's byte size. This
budget grows with tile dimensions. Gradients must be regenerated on slot reuse;
loading a different tile into a slot must never reuse stale gradients.

### Sunlight cache: exact sampled reuse, more invalidation work

The experiment stores visibility at the same 33×33 grid points as a 32×32 mesh.
At those points, `r32float` cache values matched the existing ray march exactly
in all six tested patch/Sun combinations. It does not replace the shader's
interpolation across triangles or improve the ray march's spatial resolution.

One coarse low-Sun cache build costs 0.02437 ms; one polar low-Sun build costs
0.05911 ms. A cache has to be built before it can be read. With the measured GPU
costs, both low-Sun cases break even on the second draw using the cache:

```text
cached total = build cost + number of draws × lookup cost
current total = number of draws × direct calculation cost
```

The same is true of the complete fixture's normal-cache build versus repeated
262,144-sample normal workloads. This is kernel-only amortization; compilation,
allocation and submission can change the integration result.

At 4 bytes per value, 128 cached 33×33 patch grids cost about **0.53 MiB**, before
atlas padding. This cache belongs to a drawn geometry patch, not simply to the
resident height tile. Two geometry patches sampling the same height tile can
have different world locations, grid sizes, UV mappings and feather widths.
A bounded atlas is preferable to assuming an unlimited number of array layers.

A sunlight entry depends on:

- Geometry patch address, grid resolution and cube-face transform.
- Sun direction and shadow-quality settings.
- Height bindings, UV mapping, blend state, elevation state and height bounds.
- Resident height coverage, including relevant occluders outside the patch.
- The mesh-cell size used by the current shadow feathering calculation.

Initially, invalidate conservatively on any resident-height change, including
fades and evictions. A new mountain outside the displayed patch can change its
shadow. Optimizing the dirty region is a later feature requiring conservative
occluder bounds.

## What this means for camera motion and streaming

- **Idle view:** our renderer already renders on demand. Caching saves no frames
  while nothing changes; there is no idle ray march to eliminate.
- **Camera motion, stable terrain and Sun:** reuse cached entries for patches
  that remain selected. Normal/sunlight work can be avoided while drawing new
  viewpoints. Newly selected geometry patches still need sunlight entries.
- **Loading or fading elevation:** normal gradients can be built per arriving
  height tile, but the hybrid keeps the original normal calculation during the
  fade. Sunlight frequently becomes dirty; avoid rebuilding and immediately
  discarding it every frame. Use the direct path until the input state is stable.
- **Moving the Sun:** shadow cache contents are immediately stale. Rendering
  directly during continuous Sun movement avoids paying a build cost for data
  that will only be used once.

These interaction cases are architectural consequences of the measured costs,
not measured browser traces of an orbit, flight, or loading sequence.

## Recommended integration

First integrate the **settled-tile gradient cache behind a toggle**: it has local
inputs, a small lifecycle boundary, and a measured transition-safe fallback.
Retain the current normal path whenever the tile is fading or its gradient slot
is not ready. Then compare complete frame GPU time and memory under real camera
movement and streaming with 64 resident height slots. Test cube-face seams,
gutters, poles, parent fallback, and evicted/reused slots before enabling it by
default.

The **sunlight cache has the larger upside** and deserves a second opt-in path.
It needs stable geometry-patch IDs, a bounded atlas and invalidation revisions,
a pre-render compute stage, a per-frame cache-build budget, and direct fallback
for missing/dirty entries. It should continue emitting the same single sunlight
varying; it does not need more fragment varyings. Integrating it into Three.js
may change the cost substantially from this raw compute experiment.

Do not move CPU clearance or DOM marker projection to the GPU as part of this.
There is no GPU readback in the proposed drawing path.

## Rerun locally

These commands are for this repository and require the downloaded lunar
height pyramid, including the south-polar region:

```sh
npm run benchmark:terrain:prepare
npm run dev
```

Open `http://localhost:5173/benchmarks/terrain-cache/` (use the port Vite prints).
Click **Run benchmark** and then **Save JSON**. Keep the tab visible and avoid
other GPU workloads. The page requires WebGPU and timestamp-query support.
Browser timestamp precision and device power state can affect very small lookup
measurements. The runner keeps timestamps separate from validation readbacks and
destroys its GPU device afterward.

Prepared data is written only to ignored `public/benchmarks/terrain-cache/`;
the existing Moon data and default renderer are unchanged. The benchmark and its
JSON reports are development tools, not part of the npm library's public API.
