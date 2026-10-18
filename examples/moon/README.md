Moon demo instructions (run commands from the repository root).

The default example now has a **Body** selector for Moon, Earth, and Mars.
See the [solar system example](../planets/README.md) for dataset paths and URL overrides.

# Globes

Interactive lunar globe. Terrain is one instanced draw: the CPU selects cube-face tiles into fixed numeric buffers, and the GPU projects that shared grid onto the Moon.

`viewer.ts` composes the library’s `tiledSurface()` with the Moon sky, Sun, and
Apollo model layers, plus the generic marker layer populated with Moon places.
Below about 80 m, a shader grows small rocks on the ground near the camera. Each layer reads shared camera, height, and Sun state and
cleans up through `globe.dispose()`. See [composition](../../docs/composition.md)
for the extension contracts. The UI and landing-site catalog stay in this example.

Drag to orbit. Right-drag or Shift-drag to look left, right, and toward the horizon. Scroll to zoom. The Moon stays at the origin. Distances are meters.

## Run

```sh
npm install
npm run dev
```

Open http://localhost:5173. The included overview is a 2048×1024 NASA color map. WAC imagery and LOLA elevation appear when tile-service is serving those pyramids. See [tile-service data guide](../../../tile-service/docs/data.md).

F5 in VS Code launches the configured browser debugger against the dev server.

## Controls

The panel selects the surface layer (WAC tiles, NASA color, or a numbered checkerboard), jumps to orbit / 10 km / 10 m, and toggles true-scale elevation and wireframe. Scroll changes altitude above the ground, down to 10 m. Drag orbits, and the orbit slows so the surface tracks the cursor. Right-drag or Shift-drag looks left and right and tilts from straight down toward the horizon. Sun longitude and latitude move the phase. Sunlight shades all imagery after blending; photographed shadows remain baked in. Apollo landing sites are labeled on the surface, and the site selector jumps to 10 km above a landing site. The globe renders when the camera or imagery changes.

## Develop

```sh
npm test
npm run typecheck
npm run build
npm run preview
```

`npm test` runs the Node test runner. It checks selection, culling, imagery residency, elevation, and the WebAssembly bounds kernel. It does not drive a GPU.

`npm run build` typechecks and bundles with Vite. The overview JPEG is emitted with the bundle. Imagery pyramids stay in tile-service. Dev and preview proxy `/data/moon`, `/data/earth`, and `/data/mars` to it.

## Layout

| Path                      | Role                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/globe.ts`            | One frame: camera, then selection, then the draw                                                          |
| `src/tiles/`              | Which cube-face leaves are on screen                                                                      |
| `src/tile-producer.ts`    | Packs that selection into one instance buffer                                                             |
| `src/rendering/`          | The instanced draw and its WGSL                                                                           |
| `src/imagery/`            | WAC tiles and sparse regional NAC imagery for that draw                                                   |
| `src/elevation/`          | Optional LOLA heights. `bounds-wasm.ts` is the fast kernel; `bounds.ts` is the same pyramid if Wasm fails |
| `examples/moon/config.ts` | Moon radius and display exposure; engine budgets are library options                                      |
| `native/`                 | Wasm height-bounds source. The viewer loads the built `.wasm` from `src/elevation/`                       |
| `scripts/`                | Builds the Wasm kernel. Tile generation lives in `../tile-service`                                        |
| `public/data/`            | Small bundled assets. Pyramids are served from `../tile-service/public/data`                              |
| `tests/`                  | Node tests. They do not drive a GPU                                                                       |

## Credits

Overview and elevation: [NASA Scientific Visualization Studio CGI Moon Kit](https://svs.gsfc.nasa.gov/4720/), LRO/LROC and LOLA. WAC mosaic: LROC Team / ASU / USGS. The overview is a visualization product, not calibrated science data. Provenance for the bundled JPEG is in `public/data/moon/README.md`.

For high-resolution Apollo imagery, run `npm run data:apollo -- --list` in tile-service, or see [the Apollo data guide](../../../tile-service/docs/data.md#apollo-landing-sites).

Elevation can stream as numeric cube tiles. In tile-service, prepare the coarse base with
`npm run data:elevation:tiles`, then add a landing-site DTM with
`npm run data:apollo:elevation -- --site apollo12`. The globe automatically uses
that bounded height cache after reload. See [streamed elevation](../../../tile-service/docs/elevation-tiles.md)
for data conventions, SLDEM import and validation limits.

Apollo lunar modules are optional: the model is not bundled. To show them, place a
Y-up GLB (Draco compression supported) at `public/data/Apollo Lunar Module.glb`; without
it the viewer logs one info message and skips them. The Draco decoder is bundled in `data/draco`.
With a model in place, choose an Apollo site under **Go to location**, then choose **Surface · 10 m**
to inspect the model. Models load on approach, share geometry/materials, and use
camera-relative positions. Their height is normalized to 7.0358 m with feet at
the sampled terrain height. Full landed LMs illustrate scale; they do not depict
the descent stages remaining today. Historical headings and landing tilt are
not reconstructed, and terrain/data registration limits placement accuracy.

Shackleton's marker uses the [USGS Gazetteer](https://planetarynames.wr.usgs.gov/Feature/5450)
center at 89.67° S, 129.78° E. It is also in **Go to location**.

For Shackleton polar imagery and elevation, run `uv run tile-service polar --info`
in tile-service to see the 11.74 GB source download, then `uv run tile-service polar` to fetch and build
resumable coverage extending 44 km from the south pole, with finer detail within
16 km of Shackleton. Existing downloads are reused. See [polar data instructions](../../../tile-service/docs/data.md#download-the-shackleton-polar-pack).

Terrain lighting now includes bounded height-field sunlight occlusion and a
Hapke reflectance model with a 20° mean slope. Choose **Neutral terrain · lighting
inspection** to evaluate shadows without photographic lighting. Controls and
accuracy/performance limits are described in [lighting notes](../../docs/lighting.md).
