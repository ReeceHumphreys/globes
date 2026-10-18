# Lunar terrain lighting

The viewer starts with **Hapke surface reflectance** and **Terrain blocks sunlight**
enabled. Both can be toggled in the panel. The main **Terrain sunlight shading**
checkbox bypasses both. Choose **Neutral terrain · lighting inspection** to see
the modeled lighting without shadows already baked into WAC/NAC photographs.
Checkerboard mode remains an unlit orientation diagnostic.

## Terrain blocking sunlight

`terrain-sunlight.wgsl` traces from each surface grid vertex toward the Sun, using
meters and the same numeric elevation textures as terrain. Visibility feathers
across the silhouette instead of flipping from lit to black. The ramp is about
two mesh cells wide and grows with distance like a widened solar disc, so
interpolation does not leave a hard triangle edge. The result is one interpolated
value. A per-pixel march would need more varyings than WebGPU's limit of 16.
Low/medium/high quality uses 12/24/48 samples per ray; medium is the default.
Geometric sample spacing covers nearby detail and longer distances, with a
terrain-height-based distance limit capped at 400 km.
A small height bias reduces self-shadowing from quantization.

The ray's altitude is evaluated with a rationalized sphere-distance formula,
avoiding subtraction of two approximately 1.7-million-meter float32 numbers.
This also works at either geographic pole. Samples cross cube/tile boundaries
through a sparse resident-height quadtree, rather than clamping to the edge of
the originating tile. Fine data follows the same parent/fine fade as the height
cache. The height array is read only for the accepted node, and for its parent
while that node is still fading in. Missing fine data uses resident coarser
ancestors or the zero-meter fallback sphere. The legacy global elevation grid
is also supported.

The lookup index is two RGBA32F texels per quadtree node. The default 64-tile,
20-level allocation is 45,056 bytes. No extra vertex buffers, attributes,
terrain draw calls, source downloads, or CPU shadow ray traces are introduced.
The CPU updates this small metadata texture with height residency and fades.
A local 1,000-rebuild check of 64 independent depth-20 branches averaged about
0.017 ms per rebuild; this is an index microbenchmark, not frame-time evidence.

Finite samples can miss thin/distant ridges. Shadows smaller than a grid cell
can soften or disappear. Fine offscreen terrain that is not resident contributes
only its coarse fallback. This implementation
is a real-time visualization, **not a scientific illumination/PSR solver**.
The Sun is a parallel light source. Shadow edges use a widened solar-disc
penumbra; terrain interreflection and Earthshine are not modeled.

## Hapke reflectance

`hapke.wgsl` implements Hapke reflectance: single-particle
Henyey–Greenstein scattering, shadow-hiding opposition brightening, isotropic
multiple scattering through the approximate Chandrasekhar H function, and
macroscopic roughness. It uses incidence, emission and phase angles from the
surface normal, Sun vector and camera-to-surface view direction. View direction
is computed in camera-relative coordinates before rotation into the Moon frame,
preserving near-surface precision.

The visualization preset is single-scattering albedo `w=0.23`, HG asymmetry
`g=-0.3`, opposition amplitude `B0=1`, opposition width `h=0.05`, and a mean
facet slope of 20°. These are illustrative constants, not a fitted or spatially
varying lunar parameter map. Porosity and coherent backscatter terms are
omitted. This is a reduced Hapke model, not the complete Hapke 2012 model. The
[USGS ISIS documentation](https://isis.astrogeology.usgs.gov/dev/Application/presentation/Tabbed/lrowacphomap/lrowacphomap.html)
describes the full model and photometric correction workflow; the
[ISIS Hapke class](https://isis.astrogeology.usgs.gov/9.0.0/Object/Programmer/_hapke_8cpp_source.html)
is the roughness arrangement used here.

Reflectance is normalized to unit brightness at nadir/full illumination, using
that same 20° slope, so overhead full sun stays at 1. At zero phase the disk
barely changes. At a nonzero phase the roughness term darkens the bright limb.
A 20° slope does not brighten the terminator. Grazing illumination fades out
over a few degrees instead of clipping to zero, so noisy terrain normals do
not sparkle along the terminator. Both the reflectance and the artistic
daylight floor obey terrain visibility; a fully occluded surface has no direct
light. An analytic sphere inside the minimum terrain height also blocks the
deep night side, even with terrain-shadow tracing disabled. Its horizon allows
elevated peaks and a finite solar disk. The inner sphere is conservative;
near-horizon terrain blocking still depends on the bounded height-field trace.
Surfaces that face away from the sun
stay at zero radiance. Turning Hapke off returns cosine (Lambert) lighting
while retaining the independent terrain-shadow control.

## Camera

The shaded color stays scene-linear. The renderer applies the **Exposure**
slider before AgX and then encodes sRGB. Default exposure is **+2 stops** (4×
linear radiance), chosen for readability of the dark WAC morphology mosaic.
This is a display preset, not calibrated solar irradiance or camera exposure.
The slider spans −2 to +5 stops; 0 restores the previous 1× exposure. Exposure
does not add ambient light or change the Hapke phase curve. Fully blocked ground
and the deep night side remain black.

Photographs keep their existing light and shadows. Multiplying this model onto
them does not remove their original illumination or create a calibrated albedo
product. Neutral terrain is the clean comparison mode. Reliable relighting of
imagery requires photometric normalization and suitable source reflectance data.

## Validation

The production build and 70 Node tests pass, including sparse-index bounds,
eviction, all six roots, deep branches, parent fades and delayed network arrivals.
The actual generated Three.js vertex/fragment pipeline was validated on an
Apple M5 Pro Metal adapter with eight vertex buffers and sixteen attributes.
Native GPU compute checks executed the real WGSL functions and verified:

- Unit normalized Hapke brightness at nadir/full phase, increased opposition
  brightness, no direct light a few degrees past the terminator, and finite
  results near grazing angles. Those Hapke checks predate the 20° roughness
  term. A Node test locks that curve against the ISIS arrangement and does not
  execute the WGSL.
- Height lookups across all six faces, through missing branches, and a 50% parent
  transition (100 m parent / 500 m fine returns 300 m).
- Low-angle sunlight blocked by an analytic ridge at the pole and equator;
  high-angle sunlight clearing it; disabling shadows bypassing the trace.

## Visible Sun

`src/rendering/sun-layer.ts` draws a camera-facing solar disk with an approximate
0.533° diameter and a soft optical glow. Its direction follows the same Sun
longitude/latitude controls as terrain shading and the landers' directional
light. It adds no second light and no atmospheric scattering.

The WebGPU `LensflareMesh` addon provides small optical flare elements and
depth-buffer occlusion. The **Sun lens flare** checkbox disables those elements;
the disk remains. Flare is an illustrative camera effect, not a simulation of
a specific lens. Disk/glow use depth testing; terrain can hide them. The flare
addon's visibility samples are approximate near a partly occluded solar disk.

To find the Sun from the initial orbit, set longitude to about **150°** and
latitude to **0°**. It should sit beside the lunar limb. It may otherwise be
off-screen or behind the Moon. No continuous animation is added.

These checks validate shaders and numeric behavior; the browser scene still
needs visual inspection on target devices. GPU timestamp queries in the local
microbenchmark returned zero values, so no GPU-time/FPS claim is made.
