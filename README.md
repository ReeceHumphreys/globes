# tiled-globe

Streamed, tiled planetary globes for three.js WebGPU. A `TiledGlobe` is an ordinary
`Object3D`: add it to your scene, update it each frame, and it selects cube-face quadtree
tiles for your camera, streams imagery and elevation into bounded GPU caches, and draws
them with one instanced grid. `GlobeControls` orbits and zooms down to the surface.

```ts
import * as THREE from "three/webgpu";
import { TiledGlobe, GlobeControls } from "tiled-globe";

const renderer = new THREE.WebGPURenderer({ reversedDepthBuffer: true });
await renderer.init();
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

## Develop

Needs Node 24 or newer.

```sh
npm install
npm test
npm run build   # The library, into dist
npm run docs    # API reference from the doc comments, into docs
npm run dev     # The example viewer: see examples/viewer
```

To use it in another app before it is published, run `npm pack` and install the tarball
with `three@^0.186.1`.

## Limits

Spheres, flattened spheres and the normalized-cube tile format only: this is not a GIS
engine. Heights are relative to the globe's reference surface, with no geoid conversion.
Elevation is fixed at 0.5 m units from −10000 m, so it spans −10000 to +22767.5 m.
Lighting is real-time visualization, not a scientific illumination model.

## License

MIT. See [LICENSE](LICENSE). Bundled assets keep their own terms: see the README beside each.
