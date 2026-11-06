# Viewer

The Moon, Earth and Mars, one at a time, using `tiled-globe` as an application would.

```sh
npm run dev   # From the repository root
```

It runs on its bundled overview images. For tiled imagery and elevation, run
`docker compose up -d --build --wait` in the sibling `tile-service` repo. Dev and preview
proxy `/data/moon`, `/data/earth` and `/data/mars` to `http://127.0.0.1:8787`.
`VITE_TILE_BASE`, in the environment or `.env.local` here, overrides that target and
selects dataset URLs in production builds.

`npm run data:ocean-mask` and `npm run data:usa-coastline` rebuild the data in `assets`.
