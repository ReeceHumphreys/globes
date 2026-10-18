import {
  createSpacecraftLayer,
  parseOem,
  parseTle,
  subsolarPoint,
  type Globe,
  type SpacecraftLayer,
} from "tiled-globe";

/**
 * Opt-in demo: `?tle=<url>` or `?oem=<url>` adds spacecraft for the current body.
 * `?rate=` sets simulated seconds per second. OEM playback starts at the data when
 * the wall clock lies outside its coverage.
 */
export async function addQuerySpacecraft(
  query: URLSearchParams,
  globe: Globe,
  signal: AbortSignal,
): Promise<SpacecraftLayer | undefined> {
  const tle = query.get("tle"),
    oem = query.get("oem");
  if (!tle && !oem) return undefined;
  const response = await fetch((tle ?? oem)!, { signal });
  if (!response.ok) throw new Error(`Spacecraft data request failed: ${response.status}`);
  const ephemerides = tle ? parseTle(await response.text()) : parseOem(await response.text());
  const now = Date.now();
  const starts = ephemerides.map((ephemeris) => ephemeris.startMs ?? now);
  const covered = ephemerides.some(
    (ephemeris) => now >= (ephemeris.startMs ?? now) && now <= (ephemeris.stopMs ?? now),
  );
  if (signal.aborted) return undefined;
  const rawRate = query.get("rate");
  const rate = rawRate === null || rawRate === "" ? 1 : Number(rawRate);
  if (!Number.isFinite(rate)) throw new RangeError("Invalid spacecraft rate");
  const layer = createSpacecraftLayer(ephemerides, {
    timeMs: covered ? now : Math.min(...starts),
    rate,
  });
  await globe.addLayer(layer);
  return layer;
}

/**
 * Light the globe for the spacecraft clock. The Sun moves only after a 0.1° change, so
 * terrain sunlight caches can settle between steps. Returns an unsubscribe function.
 */
export function sunFollowsClock(
  globe: Globe,
  layer: SpacecraftLayer,
  bodyName: string,
  onTick: (timeMs: number, sun: { longitudeDeg: number; latitudeDeg: number }) => void,
): () => void {
  let applied: { longitudeDeg: number; latitudeDeg: number } | undefined;
  const update = () => {
    const timeMs = layer.getTimeMs();
    const sun = subsolarPoint(bodyName, timeMs);
    const moved =
      !applied ||
      Math.abs(sun.latitudeDeg - applied.latitudeDeg) > 0.1 ||
      Math.abs(((sun.longitudeDeg - applied.longitudeDeg + 540) % 360) - 180) > 0.1;
    if (moved) {
      applied = sun;
      globe.setSun(sun.longitudeDeg, sun.latitudeDeg);
    }
    onTick(timeMs, applied!);
  };
  update();
  return globe.onFrame(update);
}
