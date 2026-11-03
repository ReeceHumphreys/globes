import { geographicToDirection } from "tiled-globe";

export { APOLLO_LANDING_SITES, type Place } from "./data/landing-sites.ts";

/** Unit direction of a place in the Moon's body-fixed frame. */
export function placeDirection(place: {
  latitudeDeg: number;
  longitudeDeg: number;
}): [number, number, number] {
  const { x, y, z } = geographicToDirection(place.latitudeDeg, place.longitudeDeg);
  return [x, y, z];
}
