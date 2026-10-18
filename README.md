# tiled-globe

A TypeScript library for spherical, tiled globes using Three.js WebGPU. It
provides cube-face quadtree selection, one shared instanced terrain grid,
bounded imagery/elevation streaming, parent fallback, and orbit-to-surface
camera controls. Surfaces are replaceable, and optional scene layers share camera,
Sun, viewport, and lifecycle state. The Moon viewer is an application built on this library.

Run `npm run dev` for the [solar system example](examples/planets/README.md).
It opens on the Sun, Earth, Moon, and Mars. Scrolling in on a body opens that globe, and scrolling out returns to the solar system.

```ts
import { createGlobe, tiledSurface, createSunLayer } from "tiled-globe";

const globe = await createGlobe({
  container: document.querySelector<HTMLDivElement>("#globe")!,
  body: { name: "Mars", radiusMeters: 3_389_500 },
  surface: tiledSurface({
    overview: "/data/mars/overview.jpg",
    imagery: "/data/mars/imagery/manifest.json",
    elevation: { tiles: "/data/mars/elevation-tiles/manifest.json" },
  }),
  layers: [createSunLayer()],
});

// Release observers, event handlers, downloads and owned GPU resources.
// globe.dispose();
```

The container must have a nonzero size. WebGPU requires a supported browser and
HTTPS or localhost. Three.js is a peer dependency. There is no built-in UI,
planetary dataset, marker catalog, atmosphere, or lunar model in the library.

- [Installation and API](docs/library.md)
- [Surface and scene-layer composition](docs/composition.md)
- [Shared lighting environments](docs/environments.md)
- [3D Tiles integration assessment](docs/3d-tiles-assessment.md)
- [Experimental Earth and Mars atmospheres](docs/experimental-atmosphere.md)
- [Experimental WebGPU clouds](docs/clouds.md)
- [Earth ocean shading](docs/oceans.md)
- [Generic markers](docs/markers.md)
- [Orbiting spacecraft from TLEs and OEMs](docs/spacecraft.md)
- [Shader performance and compute candidates](docs/shader-performance.md)
- [Measured terrain-cache investigation](docs/terrain-cache-investigation.md)
- [Generate and serve imagery/elevation tiles](../tile-service/docs/tile-generation.md)
- [Moon example and its datasets](examples/moon/README.md)
- [Current rendering/lighting limits](docs/lighting.md)

## Work in this repository

```sh
npm install
npm run dev             # Moon example, using the library source
npm run build           # Package + declarations + demo
npm run preview         # Production Moon demo
npm test
```

Start `docker compose up -d --build --wait` in the sibling `tile-service` repo first. Dev and preview
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
Mercator/XYZ sources, atmospheres, ocean rendering, and time-dependent reference
frames for the globe itself are not implemented (spacecraft ephemerides are
rotated into the body-fixed frame). Numeric elevation currently uses the documented
fixed uint16 encoding; files outside its range are rejected, not clipped.

## License

MIT. See [LICENSE](LICENSE). Bundled third-party assets keep their own terms;
see the README beside each asset.
