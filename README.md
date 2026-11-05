# tiled-globe

Streamed, tiled planetary globes for three.js WebGPU. A `TiledGlobe` is an
ordinary `Object3D`: add it to your scene, update it each frame, and it selects
cube-face quadtree tiles for your camera, streams imagery and elevation into
bounded GPU caches, and draws them with one instanced grid. `GlobeControls`
orbits and zooms down to the surface, like `OrbitControls`.

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

Run `npm run dev` for the [viewer example](examples/viewer/main.ts): the Moon,
Earth and Mars, one at a time. WebGPU requires a supported browser and HTTPS or
localhost. three.js is a peer dependency.

- [Library guide](docs/library.md)
- [Current rendering/lighting limits](docs/lighting.md)
- [Shader performance and compute candidates](docs/shader-performance.md)
- [Measured terrain-cache investigation](docs/terrain-cache-investigation.md)
- [3D Tiles integration assessment](docs/3d-tiles-assessment.md)
- [Moon example datasets](examples/moon/README.md)
- [Generate and serve imagery/elevation tiles](../tile-service/docs/tile-generation.md)

## Work in this repository

```sh
npm install
npm run dev             # Viewer example, using the library source
npm run build           # Package + declarations + demo
npm run preview         # Production viewer build
npm test
npm run benchmark:render  # Real GPU frame times in headless Chrome
```

Development needs Node 24 or newer.

The viewer runs on its bundled overview images alone. For streamed imagery and elevation, start
`docker compose up -d --build --wait` in the sibling `tile-service` repo. Dev and preview
proxy `/data/moon`, `/data/earth`, and `/data/mars` to `http://127.0.0.1:8787`.
The viewer never starts or stops the file service. `VITE_TILE_BASE`, set in the
environment or `.env.local`, overrides the proxy target and selects dataset URLs
in production builds. Use a browser-accessible URL, for example
`VITE_TILE_BASE=https://files.example.com npm run build`. Release prefixes are
supported. Leave it unset when the deployed app reverse-proxies `/data/...` on
the same origin. Black Marble night lights stay in this
repo at `public/data/earth/night-lights` and are not proxied. The demo build
copies the remaining `public/` files. Pyramids stay in tile-service. Published manifests can select PMTiles archives;
imagery, height tiles, and regional imagery then load directly through HTTP ranges.
Geometry and shaders keep the existing cube layout. See
[PMTiles publication](../tile-service/docs/pmtiles.md) for packaging and deployment.
For deployment, host the manifests, metadata pages, and referenced archives at the
same `/data/...` paths, or point the proxy at a static host that allows Range requests.

The library builds into `dist/library`; the demo builds into `dist/demo`.

## Install the package locally

```sh
npm pack --pack-destination /tmp
# In another application:
npm install /tmp/tiled-globe-0.1.0.tgz three@^0.186.1
```

The package has not been published to the npm registry. A tarball can be installed
with npm now. Choose the intended package name and release version
before publishing.

## Scope

Bodies are spheres with planetocentric latitude and east-positive longitude.
Earth can use a spherical visualization, but ellipsoid/terrain datum conversion,
Mercator/XYZ sources are not implemented. Numeric elevation currently uses the documented
fixed uint16 encoding; files outside its range are rejected, not clipped.

## License

MIT. See [LICENSE](LICENSE). Bundled third-party assets keep their own terms;
see the README beside each asset.
