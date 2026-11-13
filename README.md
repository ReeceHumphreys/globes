# tiled-globe

Streamed, tiled planetary globes for three.js WebGPU. A `TiledGlobe` is an ordinary
`Object3D`: add it to your scene, update it each frame, and it selects quadtree tiles for
your camera, streams imagery and elevation into bounded GPU caches, and draws
them with one instanced grid. `GlobeControls` orbits and zooms down to the surface.

```ts
import * as THREE from "three/webgpu";
import { TiledGlobe, GlobeControls } from "tiled-globe";

const renderer = new THREE.WebGPURenderer({ reversedDepthBuffer: true });
await renderer.init();
renderer.highPrecision = true; // Objects in a GlobeAnchor stay still to the centimetre.
document.body.append(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 1, 1e9);
const sun = new THREE.DirectionalLight(0xffffff, 3);
scene.add(sun, sun.target);

const mars = new TiledGlobe({
  name: "Mars",
  radius: 3_396_190,
  imagery: "/data/mars/imagery/manifest.json",
  elevation: "/data/mars/elevation-tiles/manifest.json",
  sun,
});
scene.add(mars);
const controls = new GlobeControls(camera, renderer.domElement, mars);

renderer.setAnimationLoop(() => {
  controls.update();
  mars.update(camera, renderer);
  renderer.render(scene, camera);
});
```

WebGPU needs a supported browser on HTTPS or localhost. three.js is a peer dependency.

Any dataset that follows the tiled dataset contract works, whatever published it. The contract is in `tile-service/spec`, and `tests/contract` holds a copy of its conformance files.

## 3D Tiles

The globe doesn't stream 3D Tiles itself. Use
[3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS) and add its group to
the globe; a `TerrainMask` hides the coarser terrain under the scan.

```ts
import { TilesRenderer } from "3d-tiles-renderer";

const tiles = new TilesRenderer("/pad/tileset.json");
tiles.group.rotation.x = -Math.PI / 2; // Earth-centered z-north into the globe's y-north
earth.add(tiles.group);
earth.add(new TerrainMask(28.6083, -80.6041, { width: 120, length: 90 }));
tiles.setCamera(camera);
// Each frame, after earth.update:
tiles.setResolution(camera, renderer.getDrawingBufferSize(new THREE.Vector2()));
tiles.update();
```

The tileset must use the same body as the globe, such as WGS84 for Earth. See
`examples/tiles3d`.

## Develop

Needs Node 24 or newer.

```sh
npm install
npm test
npm run build   # The library, into dist
npm run docs    # API reference from the doc comments, into docs
npm run dev     # The example viewer: see examples/viewer
npm run dev:tiles3d  # A 3D tileset on the globe: see examples/tiles3d
```

To use it in another app before it is published, run `npm pack` and install the tarball
with `three@^0.186.1`.

## Limits

Spheres and flattened spheres only. The globe is the layer a GIS or a Cesium-style app
builds on, not one itself: see [DESIGN.md](DESIGN.md). Tiles use a geographic grid with
polar stereographic caps above 80°; other formats plug in as an `ImagerySource` or
`HeightSource` that reprojects into it. Heights declare their own scale, offset and
vertical datum, and a flattened globe rejects heights that aren't ellipsoidal.
Lighting is real-time visualization, not a scientific illumination model.

## License

MIT. See [LICENSE](LICENSE). Bundled assets keep their own terms: see the README beside each.
