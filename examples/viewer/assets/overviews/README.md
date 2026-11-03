# Bundled overview images

Each body has a 2048 × 1024 equirectangular overview so the viewer works without
tile-service. All three are north-up, longitude −180° at the left, 0° at the
center and +180° at the right, latitude +90° at the top. With tile-service running,
streamed imagery and elevation replace them as you zoom in.

## Moon: `moon-2k.jpg`

- Source: NASA Scientific Visualization Studio, CGI Moon Kit (2025 color edition).
- Page: https://svs.gsfc.nasa.gov/4720/
- Original: https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg
- Local file: `moon-2k.jpg`, unchanged download, 2048 × 1024 RGB JPEG.
- Downloaded: 2026-10-17.
- SHA-256: f7130a1822681fa7512d7dcfd40db8c10b9ba4f06777910348698260ed7a2170
- Credit: NASA's Scientific Visualization Studio; LRO/LROC instrument teams.

North-up equirectangular map, longitude -180° at left, 0° at center, +180°
at right; latitude +90° at top and -90° at bottom. East-positive longitude.
In our right-handed Y-up scene, +X is longitude 0°, -Z is 90°E, +Y is north.

NASA describes this as a visualization product optimized for aesthetics, not
science: source WAC bands were exposure/white-balance adjusted and polar regions
filled using LOLA albedo data. It must not be treated as calibrated reflectance,
multispectral measurements, elevation, or analysis-ready scientific raster data.
The JPEG supplies approximately 5.3 km/pixel at the equator. It is color only.
Finer WAC tiles and the elevation grid are generated separately and are not
part of this file.

## Earth: `earth-2k.jpg`

- Source: EOxCloudless Sentinel-2 cloudless 2020, https://cloudless.eox.at, by EOX IT
  Services GmbH (contains modified Copernicus Sentinel data 2020).
- **License: CC BY-NC-SA 4.0.** Attribution is required, commercial use is not
  permitted, and derivatives keep the same license. This file is under those terms,
  not the repository's MIT license.
- Made from tile-service's cached `data/raw/earth/s2cloudless-2020.tif`
  (16384 × 8192), area-averaged to 2048 × 1024 with rasterio and saved as JPEG at
  quality 88.
- SHA-256: 44d7088f166867191e518082e023cdde5a58e8a91ddc53f41ccb41aa318a3ac9

## Mars: `mars-2k.jpg`

- Source: Viking MDIM 2.1 color mosaic. NASA Ames; USGS Astrogeology Science Center.
  Public domain.
- Made from tile-service's cached `data/raw/mars/mars-viking-mdim21-232m.tif`
  (92160 × 46080), area-averaged to 2048 × 1024 with rasterio and saved as JPEG at
  quality 88.
- SHA-256: cefb00c9f96b8411285c95d9a2b6fb4b53d163129e712922c469a5a6bf8a6ab2

To regenerate Earth or Mars, in tile-service:

```sh
uv run python - <<'PY'
import rasterio
from rasterio.enums import Resampling
for body, path in {"earth": "data/raw/earth/s2cloudless-2020.tif",
                   "mars": "data/raw/mars/mars-viking-mdim21-232m.tif"}.items():
    with rasterio.open(path) as src:
        data = src.read(out_shape=(3, 1024, 2048), resampling=Resampling.average)
    with rasterio.open(f"{body}-2k.jpg", "w", driver="JPEG", width=2048, height=1024,
                       count=3, dtype="uint8", QUALITY=88) as dst:
        dst.write(data)
PY
```
