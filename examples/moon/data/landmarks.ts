import { APOLLO_LANDING_SITES, type Place } from "./landing-sites.ts";
import { ROBOTIC_LANDING_SITES } from "./robotic-sites.ts";

// USGS Gazetteer, current lunar control network; degrees east.
// https://planetarynames.wr.usgs.gov/Feature/5450
export const SHACKLETON: Place = {
  name: "Shackleton crater",
  latitudeDeg: -89.67,
  longitudeDeg: 129.78,
  kind: "landmark",
};
export const LUNAR_PLACES: readonly Place[] = [
  ...APOLLO_LANDING_SITES,
  ...ROBOTIC_LANDING_SITES.filter((site) => site.outcome === "landed"),
  SHACKLETON,
];
