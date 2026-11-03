# Moon datasets and models

The [viewer example](../viewer/main.ts) shows the Moon, Earth and Mars, one at a
time (`?body=moon|earth|mars`). This folder holds the Moon-specific parts it adds
to the Moon's `TiledGlobe`: the landing-site catalog, place labels, the 2K
overview image, Apollo lunar modules and procedural rocks. Both models are
ordinary `Group`s that ride the globe and update from the camera each frame.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173. The included overview is a 2048×1024 NASA color map.
WAC imagery and LOLA elevation appear when tile-service is serving those
pyramids; without it the globe falls back to the overview. See the
[tile-service data guide](../../../tile-service/docs/data.md).

The panel picks the body and a place to fly to, toggles place labels by country,
and sets the surface (tiled imagery, overview, neutral terrain or a checker),
shading, terrain shadows, elevation, Hapke reflectance, wireframe, shadow steps,
the Sun's position and exposure. The Sun starts at the body's current subsolar point.

## Credits

Overview and elevation: [NASA Scientific Visualization Studio CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/), LRO/LROC and LOLA. WAC mosaic: LROC Team / ASU / USGS. The overview is a visualization product, not calibrated science data. Provenance for the bundled JPEG is in [`examples/viewer/assets/overviews`](../viewer/assets/overviews/README.md).

For high-resolution Apollo imagery, run `npm run data:apollo -- --list` in tile-service, or see [the Apollo data guide](../../../tile-service/docs/data.md#apollo-landing-sites).

Elevation can stream as numeric cube tiles. In tile-service, prepare the coarse base with
`npm run data:elevation:tiles`, then add a landing-site DTM with
`npm run data:apollo:elevation -- --site apollo12`. The globe automatically uses
that bounded height cache after reload. See [streamed elevation](../../../tile-service/docs/elevation-tiles.md)
for data conventions, SLDEM import and validation limits.

Apollo lunar modules are optional: the model is not bundled. To show them, place a
Y-up GLB (Draco compression supported) at `public/data/Apollo Lunar Module.glb`; without
it the viewer logs one info message and skips them. The Draco decoder is bundled in `data/draco`.
With a model in place, choose an Apollo site under **Places**, then zoom in to
inspect the model. Models load on approach, share geometry/materials, and use
camera-relative positions. Their height is normalized to 7.0358 m with feet at
the sampled terrain height. Full landed LMs illustrate scale; they do not depict
the descent stages remaining today. Historical headings and landing tilt are
not reconstructed, and terrain/data registration limits placement accuracy.

Shackleton's marker uses the [USGS Gazetteer](https://planetarynames.wr.usgs.gov/Feature/5450)
center at 89.67° S, 129.78° E. It is also under **Places**.

For Shackleton polar imagery and elevation, run `uv run tile-service polar --info`
in tile-service to see the 11.74 GB source download, then `uv run tile-service polar` to fetch and build
resumable coverage extending 44 km from the south pole, with finer detail within
16 km of Shackleton. Existing downloads are reused. See [polar data instructions](../../../tile-service/docs/data.md#download-the-shackleton-polar-pack).

Terrain lighting now includes bounded height-field sunlight occlusion and a
Hapke reflectance model with a 20° mean slope. Choose **Neutral terrain · lighting
inspection** to evaluate shadows without photographic lighting. Controls and
accuracy/performance limits are described in [lighting notes](../../docs/lighting.md).
