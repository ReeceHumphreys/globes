# Global lunar visualization color map

- Source: NASA Scientific Visualization Studio, CGI Moon Kit (2025 color edition).
- Page: https://svs.gsfc.nasa.gov/4720/
- Original: https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_2k.jpg
- Local file: `src/rendering/lroc-color-2k.jpg`, unchanged download, 2048 × 1024 RGB JPEG. The viewer imports it so a deployed bundle emits this file.
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
