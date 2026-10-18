# Solar system example

Run `npm run dev` and open http://localhost:5173. The view opens on the Sun,
Earth, Moon, and Mars, with orbit lines. Drag to look around. Scroll toward a
planet and that body's globe takes over as you arrive. Scroll out and the
solar system takes back over. The Earth, Moon, and Mars buttons fly there too.
**Solar system** also returns to the orrery. The globe
is built in the background on the way in, so two renderers overlap briefly.

`?body=moon`, `?body=earth`, and `?body=mars` still open that globe directly.

All three bodies have the shared star background, Sun disk and optical flare,
exposure, sunlight direction, terrain shading, terrain shadow quality, and
derived lighting cache controls. Sunlight shading starts enabled. Moon retains
its mission markers and lunar Hapke reflectance. Earth uses those same labels
for Starbase and Kennedy Space Center. The Sun disk is approximately 0.533° for Earth/Moon and 0.35° for
Mars. Sun direction is controlled manually, not by an ephemeris.
Mars loads the MOLA elevation tiles. Earth loads the ETOPO 2022 ice-surface
tiles. Earth has an experimental atmosphere, static volumetric clouds and ocean
reflections. Mars has an approximate dust atmosphere with selectable clearer and
dustier conditions; Mars clouds are not implemented yet.

Mars starts with approximately +1.6 stops of display exposure (including a
+0.35-stop presentation lift), optical depth 0.2, a selective color grade that
keeps the blue-gray terrain and polar ice distinct from the warm rusty regions,
and a 70° Sun offset from its Valles Marineris orbit view. This places a visible
terminator across the disk and reveals more relief. **Explore Mars** opens canyon, volcano, basin and polar
views with illustrative Sun angles. **Mars atmosphere** changes dust conditions
and reloads the viewer, storing the choice in `?body=mars&marsDust=clear`,
`dusty`, or `thick`. See [the Mars preset](../../docs/experimental-atmosphere.md#mars-preset).

All three use the same npm library and tiled surface implementation.

## Generated data

The defaults match pyramids in the sibling `../tile-service` checkout. Paths
below are relative to that repo. `npm run dev` proxies `/data/{moon,earth,mars}`
to `docker compose up -d --build --wait` there.

| Body  | Manifest                                              | Reference radius |
| ----- | ----------------------------------------------------- | ---------------- |
| Moon  | `public/data/moon/wac/manifest.json`                  | 1,737,400 m      |
| Earth | `public/data/earth/s2cloudless-2020-z7/manifest.json` | 6,378,137 m      |
| Mars  | `public/data/mars/viking/manifest.json`               | 3,396,190 m      |

Mars heights are `public/data/mars/elevation-tiles/manifest.json`, level 5, from
the MOLA 463 m DEM prepared at about 1.85 km per pixel. Earth heights are
`public/data/earth/elevation-tiles/manifest.json`, from ETOPO 2022 ice surface.
Earth also loads `data/earth/sites/catalog.json` when that file exists: closer
NAIP photographs of Starbase and Kennedy Space Center on the same tile pyramid.
A missing catalog is ignored.

Finish generating the tiles, then reload the page. For another output directory,
open `/?body=mars&imagery=/data/mars/viking-preview/manifest.json`, or for example
`http://localhost:5173/?body=earth&imagery=/data/earth/preview/manifest.json`.
The manifest body and radius must match. The example reads dataset attribution
from the manifest. Per-body defaults live in `bodies.ts`.

Leaving a body clears custom imagery, regions, and height URL parameters so a
Moon dataset cannot accidentally be applied to Earth. Other query parameters
are preserved. With no `body` parameter the page opens on the solar system.

See [tile generation](../../../tile-service/docs/tile-generation.md) for download
and conversion commands. The example does not automatically download raw source rasters.

## Globe navigation

- Drag a visible point to move that ground location with the pointer. At the
  poles, the camera carries its orientation smoothly across the pole.
- Scroll to zoom toward the cursor. Off the disc, zoom stays centered.
- Double-click to zoom in; Shift-double-click to zoom out.
- On touchscreens, drag with one finger and pinch with two fingers to zoom.
- Right-drag or Shift-drag to change heading and pitch toward the horizon.

Zoom scales altitude above terrain rather than distance from the center. It
stops at the configured minimum clearance and at nine body radii above the
surface. Surface picking uses a sphere at the current terrain height, rather
than intersecting every terrain triangle; steep relief may cause some drift.
There is no continuous animation or inertia when input stops.

Terrain elevation and shadow controls become available when elevation finishes
loading. The shadow ray marcher and caches use the resident elevation tiles,
with the same fallback paths as Moon. Existing photographic shadows remain
baked into the imagery; neutral terrain is useful for inspecting lighting.
Mars ice clouds and spatially varying dust remain future layers. The current
Viking colorized mosaic contains pre-existing lighting and is not calibrated
surface albedo; these changes do not recover the original reflectance.

## Experimental atmospheres

Earth and Mars enable the Takram WebGPU atmosphere adapter. Toggle **Atmosphere** to
compare it against the previous renderer. Sun direction and exposure use the
same controls; terrain shadows and cached normals remain active. Mars uses a labeled approximate dust preset, not measured weather. Clouds are not included.

See [integration and limitations](../../docs/experimental-atmosphere.md).
