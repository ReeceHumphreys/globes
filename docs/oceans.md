# Earth ocean shading

Select Earth, keep Atmosphere and Terrain sunlight shading on, and turn on
Ocean reflections. Orbit the globe and move the Sun to see its reflection move across the
oceans. Water roughness controls the highlight width: low values give a sharper
glint; higher values spread it out. Disable clouds temporarily to inspect water.

The Earth example applies a water material to the existing instanced terrain;
it does not draw a second sphere or add a draw call. Mars has no water material.
`surface-lighting.ts` connects geographic coverage, the shared atmospheric
illumination and the WGSL reflectance function in `shaders/ocean.wgsl`.

The material includes GGX microfacet Sun reflection, separable Smith masking and
Schlick Fresnel with water F0=0.0204 (refractive index approximately 1.333).
Reflected atmospheric sky becomes stronger toward grazing angles. Water uses a
radial surface normal and adjustable roughness representing unresolved waves;
land retains its elevation normal and diffuse reflectance. Direct reflections
obey the terrain's sunlight visibility. Sky reflection samples the atmosphere
LUT, blending toward hemispheric sky illumination as roughness increases; this
is an approximation to rough reflection, not a prefiltered environment map.

Ocean coverage comes from [Natural Earth's public-domain polygons](https://www.naturalearthdata.com/about/terms-of-use/),
bundled as a 4096×2048 R8 mask. The download is about 56 KiB compressed and GPU
storage is about 10.7 MiB including mipmaps. It loads asynchronously and is owned
by the viewer; the environment owns only its black placeholder. Until coverage
loads, all pixels use the ordinary terrain material. UV derivatives wrap at the
antimeridian to keep mip selection continuous.

Regenerate it with `npm run data:ocean-mask`. See the
[asset manifest and provenance](../examples/planets/assets/ocean/README.md).

The mask has about 9.8 km equatorial texel spacing and generalized coastlines.
It deliberately excludes inland lakes and does not model changing sea ice,
tides, waves, refraction, underwater scattering or bathymetric water depth.
Clouds and scene objects are not reflected. The source imagery supplies the
water's base color; it is not measured subsurface reflectance. Near-shore surface
views will need a higher-resolution streamed material mask.

Surface lighting, models, clouds, sky reflection and aerial perspective now use
the same atmosphere and Sun state. See [atmosphere integration](experimental-atmosphere.md)
for readiness, depth composition and radiometric limitations.

Validation covers pinned mask integrity and known land/ocean locations,
orientation, loader errors/abort, caller ownership, controls, generated Earth and
Mars shaders and the full terrain pipeline at the standard eight-buffer limit.
Native GPU diagnostics verify narrower/stronger glint at lower roughness,
zero direct light at night or with zero visibility, normal-incidence F0 and
stronger grazing reflection. These checks do not establish browser frame rate.
