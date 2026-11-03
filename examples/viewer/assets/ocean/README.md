# Ocean coverage

Made with Natural Earth. The source is the **v5.1.2, 1:50m ocean polygon dataset**:

https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_ocean.geojson

Natural Earth data is public domain:
https://www.naturalearthdata.com/about/terms-of-use/

`water-mask.bin.gz` contains a gzip-compressed 4096×2048 R8 equirectangular mask.
Rows go north to south; columns go from longitude -180° to +180°. Ocean is 255,
land/islands/inland lakes are 0. The mask does not describe sea ice or tides.
It is an orbital visualization mask, not a shoreline survey.

Regenerate with `npm run data:ocean-mask`, or use an already downloaded copy:
`npm run data:ocean-mask -- /path/to/ne_50m_ocean.geojson`.

The generator checks the pinned source hash. `manifest.json` records the source
and output hashes, layout and sizes. The browser fetches only the compressed
mask, not the source polygons.
