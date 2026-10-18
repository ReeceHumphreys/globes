# Experimental WebGPU clouds

Select Earth and enable **Atmosphere** and **Volumetric clouds**. The default is
48% cloud amount and Medium quality (96 primary steps), rendered at up to half
the canvas width and height with a 768²-pixel budget. Cloud amount is a coverage control, not a measurement
of the percentage of the planet obscured. Mars and the Moon do not use this
Earth prescription.

## What is ported from Takram

The density implementation is a WGSL adaptation of Takram three-clouds at source
revision `b012ad06d858fc035d88aacfd73f092f93c994e4`:

- [sampleWeather/sampleMedia](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/shaders/clouds.glsl): height-dependent semicircular shaping, weather coverage remapping, Perlin–Worley body carving, and height-dependent Worley erosion.
- [CloudLayer](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/CloudLayer.ts): density profile `0.75 * heightFraction + 0.25`.
- [CloudLayers](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/CloudLayers.ts): the representative mid-level cumulus layer at 1,000–2,200 m, density scale 0.2, shape amount 1, detail amount 1, rounding bias 0.35 and coverage filter width 0.6.
- [CloudsEffect](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/CloudsEffect.ts): body/detail repeats of 0.0003 and 0.006 cycles per meter.
- [clouds.frag](https://github.com/takram-design-engineering/three-geospatial/blob/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/clouds/src/shaders/clouds.frag): normalized phase functions, growing secondary steps toward the Sun, analytical front-to-back extinction integration, and a reduced four-order multiple-scattering approximation.

The actual upstream precomputed noise assets are bundled, not regenerated with a
replacement noise algorithm: a 128³ Perlin–Worley base volume and a 32³ Worley
detail volume. Both are tightly packed R8 data, sampled linearly with repeat on
all axes. Together they contain 2,129,920 bytes (about 2.03 MiB). Asset revision,
URLs, byte counts, SHA-256 hashes and licenses are recorded in
`examples/planets/assets/clouds/`.

This is a **density-model port**, not a complete port of the upstream cloud
renderer. The scalar equations agree at detail-on and detail-off endpoints.
The example adds a smooth interpolation between those endpoints for LOD. At
subpixel scales, shape samples converge to the measured mean of the base volume;
small detail fades out as its footprint becomes unresolved. These are explicit
filtering adaptations rather than changes to the near-field density equations.

## Weather and lighting

NASA's historical Blue Marble cloud composite remains the weather input. It
places observed fronts and storms rather than Takram's repeating procedural
weather. It is not a retrieved 3D cloud field: heights, density scales and cloud
type are assigned by this example. Coverage is kept at 0.48 for this source;
Takram's default 0.3 targets a different weather texture and produces much sparser
clouds when applied directly to the NASA composite. Low quality omits detail
erosion; Medium and High enable it where resolved.

The pass consumes scalar Sun and sky illumination from the shared Takram
atmosphere, evaluated once per ray at a representative point in the cloud layer.
Four local shadow samples use steps starting at 100 m and doubling. Direct
sunlight is blocked by the reference sphere. Phase functions are normalized by
4π. The four-order scattering approximation is smaller than Takram's default
eight-order configuration. An explicit 3× cloud radiance exposure compensation
matches the photographic terrain background; the example is not a calibrated
radiometric renderer. This gain does not change density, extinction or coverage.

## Ownership and composition

- `cloud-noise.ts` validates and decodes the binary R8 volumes, fetches them with
  an abort signal, and returns an owned pair of textures.
- `clouds.ts` owns the uniform controls and safe 1³/1×1 placeholder textures.
  Loaded maps are owned by the viewer and disposed there. Sampler filtering is
  consistent before and after loading, so shader bindings remain valid.
- `shaders/cloud-density.wgsl` contains the independently testable density math.
  `shaders/clouds.wgsl` samples the fields and marches the volume. All positions
  and ray lengths are kilometers; upstream per-meter extinction is converted
  explicitly in the integration.
- `atmosphere.ts` owns the resolution-budgeted RGBA16F cloud target and the rendering
  passes. Premultiplied cloud radiance/opacity is blended over full-resolution
  terrain/atmosphere in linear light, before the final display transform.

The local weather JPEG (about 810 KiB) and the two noise volumes load
asynchronously. Clouds stay transparent until all three maps are ready. Closing
the viewer aborts binary downloads and disposes late image loads. No frame
history or permanent animation loop is required. The completed cloud image is
reused across scene redraws until camera pose, projection, body transform, Sun,
atmosphere LUTs, maps, controls, or target size change. A scroll changes the
camera, so the clouds march with the zoom instead of sticking to the screen.
Terrain tile arrivals alone do not rerun the marcher. Disabling clouds
replaces the cached image with transparency once. This is exact image reuse for
static weather, not temporal reprojection during camera movement.

The weather texture uses about 8 MiB on the GPU; noise adds about 2.03 MiB.
The cloud target uses 8 bytes per cloud pixel: at most 4.5 MiB in Medium quality,
independently of screen pixel ratio. Full-resolution scene capture is separate.

## Budgets and remaining differences

Low/Medium/High cap primary sampling at 48/96/160 steps per cloud pixel and cap
the target at 512²/768²/1024² pixels respectively. Target dimensions preserve the
canvas aspect ratio and never exceed half its drawing-buffer dimensions. This
keeps Retina/4K displays from multiplying the cloud workload. Lower resolution
softens cloud edges while terrain stays full resolution. All use four secondary
samples per occupied primary sample. No browser FPS guarantee has been measured.

When a shape volume is completely subpixel, the density sampler skips its 3D
texture read and uses the same filtered mean as before. A paired native WebGPU
diagnostic on Apple M5 Pro/Metal at 512×512, 96 steps, measured **5.19 ms before
and 1.41 ms after** (median of five batches of ten draws; amortized readback
included). The resulting RGBA8 orbital diagnostic images were byte-identical.
These are cloud-kernel timings with representative fixed illumination, not
browser frame times, full renderer timings or a portable speed guarantee.

Not implemented from Takram: its full multilayer weather channels, turbulence,
wind/evolution, temporal jitter/reprojection/upscaling, Beer shadow maps, cloud
shadows on terrain, light shafts, ground bounce, and full eight-order scattering.
There is one representative cumulus layer, not separate low/mid/cirrus volumes.
Occlusion uses the reference sphere, matching the current atmosphere compositor,
not displaced terrain or scene-object depth. Atmospheric illumination is
representative per ray rather than per scattering sample, and atmospheric
transport is not integrated separately along every cloud path. These limitations
matter especially near mountain peaks and when entering clouds.

## Validation

Run `npm test` and `npm run build` for texture decoding, pinned asset integrity,
failed/aborted loads, caller-owned texture lifetime, placeholder bindings,
budgeted composition, unchanged-view image reuse, invalidation on camera,
projection, Sun, maps, LUTs and controls, and Earth-only lifecycle checks.

With `npm run dev`, open `/benchmarks/cloud-density/`. It compares GPU WGSL
readbacks to an independent scalar oracle for the upstream equations: 1,536
cases include cloud boundaries, zero coverage, base-shape carving, detail on/off
and the explicitly adapted LOD interpolation. Native WebGPU execution measured
a maximum absolute error of **1.58e-7**, below the **2e-6** tolerance. This checks
the density port, not equality of complete images with Takram's renderer.

The actual Three-generated cloud and final render pipelines also validate on a
native WebGPU driver. GPU orbital and close-range diagnostic previews were
inspected; those are not screenshots of the browser viewer or FPS measurements.

## Weather source and licenses

[Blue Marble: Clouds, NASA Visible Earth](https://visibleearth.nasa.gov/images/57747/blue-marble-clouds/77558l).
Local asset: `examples/planets/assets/earth-clouds-2048.jpg`.
Download: <https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/cloud_combined_2048.jpg>.
Credit: NASA/GSFC, Reto Stöckli. This combines multiple acquisition days and is
static weather, not a simultaneous or live observation.

The port and noise assets retain the upstream MIT notices, including Shota
Matsuda and Sébastien Hillaire's tileable-volume-noise notices. Full upstream
notices are in `examples/planets/assets/clouds/LICENSE.txt`, also emitted as a
linked asset in the Earth example's **Cloud rendering licenses** link.
