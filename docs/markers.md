# Geographic markers

`createMarkerLayer()` is an optional library layer. It accepts a static catalog
of geographic records; it knows nothing about Apollo, mission success, countries,
flags, or lunar landmarks. The Moon application retains that metadata and maps
countries onto generic visibility groups.

```ts
import { createGlobe, createMarkerLayer, tiledSurface } from "tiled-globe";

const markers = createMarkerLayer([
  {
    id: "region-a",
    label: "Region A",
    latitudeDeg: 10,
    longitudeDeg: 20,
    group: "science",
    heightOffsetMeters: 0,
  },
]);
const globe = await createGlobe({
  container: document.querySelector<HTMLDivElement>("#globe")!,
  body: { name: "Mars", radiusMeters: 3_389_500 },
  surface: tiledSurface({ overview: "/data/mars/overview.jpg" }),
  layers: [markers],
});
markers.setGroupVisible("science", false);
markers.setMarkerVisible("region-a", true); // group must also be enabled
// globe.dispose() owns marker cleanup.
```

Give the container a CSS position of `relative`, `absolute`, or `fixed` so the
label overlay aligns with its canvas. Labels mount inside that container rather
than the document body, supporting multiple independent viewers. Coordinates
are planetocentric latitude and east longitude in degrees. IDs must be unique;
coordinates and height offsets must be finite. Records are snapshotted at
creation; replace the layer to replace its catalog.

Default labels are plain white text. `className` selects the overlay class;
`createElement(marker)` builds each label once and may use any extra metadata
on your input records. Use `textContent` for untrusted text. The engine owns
position, visibility, and removal. Keep positioning transforms on the returned
label and style descendants for other effects. The layer uses CSS `translate`
for its screen position; custom labels may use `transform` for centering. The
Moon's existing colors and marker dots are application CSS, not library presets.
Pointer events are disabled on the overlay; custom interactive elements can opt
into `pointer-events: auto`.

Directions are calculated once into a numeric array. Camera matrices are updated
once per marker-layer frame. Projection reuses scratch storage, skips terrain
sampling on the far hemisphere and for filtered markers, and avoids DOM writes
when visibility or rounded subpixel positions have not changed. No per-marker
Three.js objects or GPU draw calls are created.

This is a DOM label system for small catalogs, not millions of points. It uses
an approximate spherical horizon and screen bounds, rather than terrain depth,
so crater rims/buildings do not occlude labels. Label overlap avoidance is not
implemented. For a dense catalog, prefer instanced GPU symbols with DOM labels
only for selected features. Compute projection followed by CPU readback would
still leave DOM layout work and add synchronization.

For application-specific renderers, `geographicDirection`, `projectMarker`, and
`createMarkerProjector` expose the shared coordinate convention. The reusable
projector accepts an output record to avoid allocating one per marker.
