# Experimental Earth and Mars atmospheres

Run `npm run dev`, select **Earth** or **Mars**, and use **Atmosphere · experimental WebGPU**
to compare against the previous renderer. Sun longitude/latitude and exposure
controls also affect the atmosphere. Compare orbit, 10 km, and surface views;
neutral terrain makes the lighting easier to inspect. Lookup tables populate
progressively on the GPU after startup, with redraws requested as stages finish.

The example pins `@takram/three-atmosphere` 0.19.1 and
`@takram/three-geospatial` 0.9.1. They are example dev dependencies; the npm
library does not import or bundle them. Moon keeps its existing rendering path. The dependency is dynamically imported
for Earth and Mars.

## Integration

- `examples/planets/atmosphere.ts` adapts the dependency's atmosphere
  to each spherical body radius and body frame. Body `(x,y,z)` maps to ECEF
  `(x,-z,y)`, preserving handedness and geographic directions.
- Models and clouds consume the direct Sun and diffuse sky illuminance. Land
  photographs keep the ordinary terrain shade. They are not multiplied by
  illuminance. Direct light obeys terrain shadow visibility. Earth can add a
  masked water material, off until its checkbox is enabled, and that water does
  use the shared illuminance.
- The compositor captures linear scene color and readable scene depth. It
  reconstructs the visible surface position using the camera inverse projection,
  including reversed WebGPU depth, then applies
  `surfaceRadiance * transmittance + scatteredRadiance`. This includes opaque
  model surfaces and displaced terrain rather than an analytical sphere.
- A readiness uniform retains fallback lighting and unchanged scene color until
  all four atmospheric table stages finish. Empty tables cannot erase the
  photographs. Table version changes reset readiness; completion requests a
  frame. Standard model lights also use the fallback until ready.
- The existing local star background, Sun disk, and flare stay in the color
  buffer. Sky transport attenuates this background and adds scattered light. No second Sun or remotely fetched
  star catalog is added. Their brightness/optics remain illustrative.
- Lookup tables use half-float storage. Their update events request frames; no
  permanent animation loop is added. Disposing the globe releases its compositor,
  scene pass, atmosphere resources, and listeners.

## Three.js r186 compatibility

The published experimental package expects the old `struct.layout` interface.
`takram-compat-plugin.ts` redirects **only Takram's** `three/tsl` imports through
`takram-tsl-compat.ts`, which exposes that interface using the native r186 struct
implementation. It does not patch Three.js, mutate installed packages, or change
other TSL imports. Keep the package versions pinned until this adapter can be
removed against a compatible upstream release.

The adapter explicitly adds Takram's shared parameter constant to each root
shader stack before conditional branches. This prevents camera/unit conversions
from referring to a constant declared only inside a lighting branch. Vite
prebundles `three`, `three/webgpu`, `three/tsl` and the dependency's NodeUtils
import together, avoiding separate optimized and unoptimized copies of core.

The same Vite plugin bundles the dependency's 1 MiB sampling-noise asset locally
from `examples/planets/assets/stbn.bin`, replacing its default GitHub URL.
The example's ordinary data download setup is still required for surface imagery
and elevation. Atmosphere lookup tables are computed locally, not downloaded.

## Library extension points

The preferred configuration passes `environment: createPlanetAtmosphere(...)`
to `createGlobe`. Land photographs keep their shaded color. Standard/PBR model
layers share its atmospheric scene lights. See the
[environment contract](environments.md).

The lower-level `GlobeOptions.renderPipeline(context)` returns an owned `{ render(), dispose() }`
compositor. It is created after scene layers attach, runs after their frame
updates, and is disposed before scene layers and the renderer. Without it, the
engine still calls `renderer.render(scene, camera)`.

`TiledSurfaceOptions.lighting(inputs)` returns a linear RGB node. Inputs include
unlit source `color`, the previous shaded `fallback`, body-fixed `normal`,
surface-to-camera `view`, `position` in meters, direct-light `sunlight` visibility,
an `imageryEnabled` node excluding neutral/checker inspection, and an `enabled` node
for the ordinary shading/debug switches. This hook preserves the shared grid,
streaming, elevation fades, normals, and shadow caches. The example adapter owns
its enabled uniform; switching atmosphere off bypasses the compositor.

## Accuracy and current scope

Earth uses a standard atmospheric profile on its spherical reference body. Mars
uses an approximate uniform dust profile described below. Neither is a date- or
weather-specific atmospheric reconstruction. The example's Sun
controls are manual. Display mosaics contain pre-existing illumination and
atmospheric effects, so they are not calibrated reflectance inputs.

Earth supports [static volumetric clouds](clouds.md), optional [ocean reflections](oceans.md),
and a separate Black Marble night-lights image. Night lights are added after the
daytime shade, so they glow without being multiplied by sunlight. Haze attenuates
them with the rest of the surface color, and clouds composite over them.
Spatially varying weather, measured Mars dust fields, underwater optics and terrain
shadowing of the atmospheric volume are not included. Below-datum terrain is
clamped to the atmospheric lower boundary for surface lighting; this does not
change its geometry. Terrain normals shadow direct light, but diffuse skylight
is not terrain-occluded. Existing optical flare is illustrative.

Validation includes the real Three.js node builders for the compositor and four
compute stages, coordinate mapping and lifecycle tests, plus native WebGPU shader
and pipeline validation of the integrated instanced terrain. Browser appearance
and whole-view GPU timing have not yet been verified.

References:

- [Takram WebGPU documentation](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/WEBGPU.md)
- [Experimental demo](https://takram-design-engineering.github.io/three-geospatial-webgpu/?path=/docs/atmosphere-readme--docs)

## Mars preset

`examples/planets/atmosphere-presets.ts` contains separate Earth and Mars inputs.
Mars uses the manifest's 3,396,190 m sphere and an 80 km computational atmosphere.
This upper boundary truncates the model; it is not a claim that the real
atmosphere ends there.

The Mars atmosphere uses an 11 km exponential scale height, mean solar
irradiance scaled by 586.2 / 1361 relative to Earth, and a 0.35 degree solar disk.
These are approximate reference conditions, not the instantaneous Sun distance
or a retrieved atmospheric profile. See the [NASA Mars fact sheet](https://nssdc.gsfc.nasa.gov/planetary/factsheet/marsfact.html).

The dust prescription is explicitly an initial visualization preset:

| Parameter                                         | Value                     | Status                            |
| ------------------------------------------------- | ------------------------- | --------------------------------- |
| Molecular Rayleigh coefficient                    | Earth coefficients × 0.02 | Rough CO2 scattering proxy        |
| Default dust optical depths at 680 / 550 / 440 nm | 0.18 / 0.20 / 0.22        | Clearer visualization preset      |
| Dust single-scattering albedos in those bands     | 0.94 / 0.90 / 0.80        | Chosen approximate inputs         |
| Dust scale height                                 | 11 km                     | Assumed exponential distribution  |
| Cornette–Shanks asymmetry parameter               | 0.7                       | One shared angular approximation  |
| Mean ground albedo                                | 0.15                      | Approximate global value          |
| Earth ozone absorption                            | Removed                   | No Earth ozone layer carried over |

Mars stores separate three-channel single-aerosol scattering instead of using
the packed Earth reconstruction, retaining its wavelength-dependent absorption.

Dust extinction is normalized by the integral of the truncated density profile,
so the vertical green-channel optical depth equals the chosen preset. Scattering stays below
extinction in every band, leaving nonnegative absorption. The Rayleigh
coefficient is a low-density proxy, not a measured CO2 spectral model.

The adapter's atmosphere toggle restores the old display path on either body.
There is no dust-storm map, weather playback, or adjustable dust loading yet.
A single wavelength-independent phase function cannot fully model the
wavelength-dependent blue region near Martian sunsets. The preset has not been
calibrated against rover radiance measurements. See [NASA PSG's discussion of
Martian scattering](https://psg.gsfc.nasa.gov/helpatm.php).

The Mars atmosphere selector offers clearer (0.2), dusty (0.5), and very dusty
(1.5) conditions at 550 nm. It stores `marsDust=clear|dusty|thick` in the URL and
reloads the viewer so all runtime constants and lookup tables use the same
profile. These are illustrative uniform scenarios, not retrieved weather or
named climatological states. NASA's [clear/dusty comparison](https://www.nasa.gov/image-article/mars-seen-clear-dusty-conditions/)
shows why a single dust state cannot represent all Mars views.

Mars starts at `log2(1361/586.2) + 0.35` ≈ **+1.6 exposure stops**. The first
term compensates the display camera for weaker reference sunlight; the extra
0.35 stops are a presentation lift. Solar irradiance stays unchanged. The
initial camera is north of Valles Marineris and the Sun is 70° east of its
viewing longitude, creating a strong terminator and showing northern terrain.
Mars imagery receives a selective display grade: 1.28× chroma, a modest copper
tint only on red-dominant terrain, and a fade back to the source in bright ice.
These are illustrative choices over a colorized
Viking mosaic, not measured reflectance or an atmospheric retrieval.
The Explore Mars selector includes the canyon, Olympus Mons, Hellas basin and
the north polar cap. Feature selections also choose an illustrative Sun angle;
manual Sun and exposure controls remain available. Locations are approximate
view centers, not surveyed landing-site markers.

A native GPU reference test at noon on the reference surface, viewed from three
body radii, measured green-channel surface transmission **0.511 → 0.762** when
changing dust optical depth 0.5 → 0.2. In-scattering fell **0.0185 → 0.00721**
in the renderer's linear units. These readbacks compare atmospheric transport
before display exposure; they are not browser screenshots or physical calibration
against Mars observations. No extra rendering pass or dataset download is added.

## Comparing washed-out renders

Earth starts at 0 exposure stops; Mars starts at approximately +1.2 as described
above. Exposure applies before the AgX display transform. The **Haze
over terrain** switch isolates aerial perspective: turning it off retains sky
scattering and the shared surface lighting, while bypassing surface attenuation
and haze. It is a diagnostic comparison, not a physically
complete mode. Full atmosphere remains the default.

A physical atmosphere reduces distant contrast. Our display mosaics are not
calibrated surface albedo and may already contain haze/illumination. Reapplying
an atmospheric model to those colors is approximate. Mars's dust choices are
illustrative conditions, not a measured current state.
Do not interpret a saturation boost as atmospheric calibration. Further tuning
should compare fixed Sun/camera/exposure views, inspect linear outputs before
tone mapping, and eventually use appropriate reflectance inputs and measured
atmospheric profiles.

The example captures linear scene color and depth into one owned render target
before the atmospheric draw. Geometry samples receive attenuation and in-scattering
to their reconstructed depth. A view ray that misses the body receives sky transport.
A ray that hits the body keeps the captured color, because sky transmittance is forced
to 0 on a ground hit. Geometry that
does not write depth, such as transparent overlays, does not provide a haze endpoint.
The final
render pipeline applies exposure, tone mapping and display conversion once.
The haze comparison is a uniform switch; it does not rebuild shaders. Fullscreen
shader tests capture QuadMesh's temporary vertex node during the draw, matching
the shader Three.js actually submits.

Earth's [WebGPU volumetric clouds with the Takram density model](clouds.md) remain
a separate budgeted pass before the final display transform. Cloud occlusion still
uses the reference sphere and cloud radiance does not yet receive separate
camera-to-cloud atmospheric transport. Scene-depth composition does not solve
those cloud limitations.
