# 3D Tiles on the globe

A 3D tileset standing on a `TiledGlobe`, streamed by
[3DTilesRendererJS](https://github.com/NASA-AMMOS/3DTilesRendererJS). Globe data comes from
the sibling tile-service, as for the viewer.

```sh
npm run dev:tiles3d
```

- `?site=pad` (default): a generated 60 m box at LC-39A, over a `TerrainMask`.
- `?site=starbase`: the Starbase launch site from the 2023 USGS Lower Rio Grande lidar, as
  a point cloud.
- `?lat=&lon=&altitude=` move the starting view; `?look=heading,distance,elevation` fixes
  an oblique view instead of the controls; `?mask=0` turns the mask off.

## Data

`public/pad` is generated and tracked:

```sh
node scripts/make-tileset.mjs public/pad 28.6083 -80.6041 -40 60 40 80
```

`public/starbase` is about 160 MB, so it is generated and not tracked. It reads a 700 m
square around the launch mount from the USGS lidar's public EPT octree (about 85 MB) and
writes one point tile per octree node. It needs Python 3.12 with `laspy[lazrs]` and NumPy:

```sh
python scripts/ept_select.py \
  https://s3-us-west-2.amazonaws.com/usgs-lidar-public/TX_LowerRioGrande_2_D22/ept.json \
  25.997 -97.157 350 nodes.json
python scripts/ept_to_3dtiles.py nodes.json public/starbase -21.275
```

`-21.275` is the GEOID18 geoid height at the site, which turns the lidar's NAVD88 heights
into heights above the ellipsoid. The matching 1 m ground heights are tile-service's
`earth/starbase-elevation` target.
