# Takram cloud noise and port notices

Upstream: <https://github.com/takram-design-engineering/three-geospatial/tree/main/packages/clouds>.
Density source revision: `b012ad06d858fc035d88aacfd73f092f93c994e4`.
Asset revision: `45a1c6c1bb9fd38b3680fd120795ff4c32df68ff`, as specified by the
upstream `src/constants.ts`. These are actual LFS payloads, not pointer files.

- `shape.bin`: 128×128×128 R8, Perlin–Worley body shape.
- `shape-detail.bin`: 32×32×32 R8, Worley detail erosion.

Source URLs:

- https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/45a1c6c1bb9fd38b3680fd120795ff4c32df68ff/packages/clouds/assets/shape.bin
- https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/45a1c6c1bb9fd38b3680fd120795ff4c32df68ff/packages/clouds/assets/shape_detail.bin

`manifest.json` pins dimensions, sizes and SHA-256 hashes. `LICENSE.txt` retains
the upstream license in full, including Shota Matsuda's MIT notice and the
Sébastien Hillaire notice for the tileable-volume-noise generation. It is bundled
and linked by the example; retain it when redistributing these assets or the port.
