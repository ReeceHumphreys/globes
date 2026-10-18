import type { Place } from "./landing-sites.ts";
import type { MarkerCountry } from "./marker-countries.ts";

const OPERATOR_COUNTRIES: Record<string, MarkerCountry> = {
  USSR: "SU",
  "USA / NASA": "US",
  "USA / Firefly Aerospace": "US",
  "USA / Intuitive Machines": "US",
  "China / CNSA": "CN",
  "India / ISRO": "IN",
  "Japan / JAXA": "JP",
  "Japan / ispace": "JP",
  "Russia / Roscosmos": "RU",
  "Israel / SpaceIL": "IL",
};

export const LANDING_SITE_SOURCE =
  "https://nssdc.gsfc.nasa.gov/planetary/lunar/lunar_artifact_impacts.html";

export type RoboticSite = Place & {
  kind: "landing" | "impact";
  year: number;
  operator: string;
  outcome: "landed" | "limited" | "crashed" | "unconfirmed";
  accuracy: "localized" | "approximate" | "unconfirmed";
};

// NASA NSSDCA catalog checked 2026-10-18. Coordinates are planetocentric,
// east-positive degrees in [-180, 180]. These mark lander sites, not current
// rover positions. Approximate historical locations are not precise targets.
const rows: readonly [
  string,
  number,
  number,
  number,
  string,
  RoboticSite["outcome"],
  RoboticSite["accuracy"],
][] = [
  ["Luna 9", 7.13, -64.37, 1966, "USSR", "landed", "approximate"],
  ["Luna 13", 18.87, -62.05, 1966, "USSR", "landed", "approximate"],
  ["Luna 16", -0.5137, 56.3638, 1970, "USSR", "landed", "localized"],
  ["Luna 17 / Lunokhod 1 landing", 38.23764, -35.00163, 1970, "USSR", "landed", "localized"],
  ["Luna 20", 3.7863, 56.6242, 1972, "USSR", "landed", "localized"],
  ["Luna 21 / Lunokhod 2 landing", 25.9994, 30.4076, 1973, "USSR", "landed", "localized"],
  ["Luna 23", 12.6667, 62.1511, 1974, "USSR", "limited", "localized"],
  ["Luna 24", 12.7142, 62.2129, 1976, "USSR", "landed", "localized"],
  ["Surveyor 1", -2.4745, -43.3398, 1966, "USA / NASA", "landed", "localized"],
  ["Surveyor 3", -3.0162, -23.418, 1967, "USA / NASA", "landed", "localized"],
  ["Surveyor 5", 1.4551, 23.1943, 1967, "USA / NASA", "landed", "localized"],
  ["Surveyor 6", 0.4742, -1.4275, 1967, "USA / NASA", "landed", "localized"],
  ["Surveyor 7", -40.9812, -11.5127, 1968, "USA / NASA", "landed", "localized"],
  ["Chang’e 3 / Yutu landing", 44.1214, -19.5117, 2013, "China / CNSA", "landed", "localized"],
  ["Chang’e 4 / Yutu-2 landing", -45.4561, 177.5885, 2019, "China / CNSA", "landed", "localized"],
  ["Chang’e 5", 43.0576, -51.9161, 2020, "China / CNSA", "landed", "localized"],
  ["Chang’e 6", -41.6385, -153.9852, 2024, "China / CNSA", "landed", "localized"],
  ["Chandrayaan-3 / Vikram", -69.3741, 32.32, 2023, "India / ISRO", "landed", "localized"],
  ["SLIM", -13.316, 25.251, 2024, "Japan / JAXA", "landed", "localized"],
  ["Odysseus / IM-1", -80.13, 1.44, 2024, "USA / Intuitive Machines", "landed", "localized"],
  ["Blue Ghost 1", 18.562, 61.81, 2025, "USA / Firefly Aerospace", "landed", "localized"],
  ["Athena / IM-2", -84.7906, 29.1957, 2025, "USA / Intuitive Machines", "landed", "localized"],
  ["Luna 5", -1.35, -25.48, 1965, "USSR", "crashed", "approximate"],
  ["Luna 7", 9, -49, 1965, "USSR", "crashed", "approximate"],
  ["Luna 8", 9.1, -63.3, 1965, "USSR", "crashed", "approximate"],
  ["Luna 15", 17, 60, 1969, "USSR", "crashed", "approximate"],
  ["Luna 18", 3.76, 56.66, 1971, "USSR", "crashed", "unconfirmed"],
  ["Luna 25", -57.865, 61.36, 2023, "Russia / Roscosmos", "crashed", "localized"],
  ["Surveyor 2", 5.5, -12, 1966, "USA / NASA", "crashed", "approximate"],
  ["Surveyor 4", 0.5, -1.5, 1967, "USA / NASA", "unconfirmed", "unconfirmed"],
  ["Beresheet", 32.5956, 19.3496, 2019, "Israel / SpaceIL", "crashed", "localized"],
  ["Chandrayaan-2 / Vikram", -70.881, 22.784, 2019, "India / ISRO", "crashed", "localized"],
  ["HAKUTO-R Mission 1", 47.581, 44.094, 2023, "Japan / ispace", "crashed", "localized"],
  [
    "RESILIENCE / HAKUTO-R Mission 2",
    60.4445,
    -4.588,
    2025,
    "Japan / ispace",
    "crashed",
    "localized",
  ],
];

export const ROBOTIC_LANDING_SITES: readonly RoboticSite[] = rows.map(
  ([name, latitudeDeg, longitudeDeg, year, operator, outcome, accuracy]) => ({
    name,
    latitudeDeg,
    longitudeDeg,
    year,
    operator,
    country: OPERATOR_COUNTRIES[operator],
    outcome,
    accuracy,
    kind: outcome === "crashed" || outcome === "unconfirmed" ? "impact" : "landing",
    sourceUrl: LANDING_SITE_SOURCE,
    detail: `${operator} · ${year} · ${outcome === "limited" ? "landed; limited mission" : outcome === "unconfirmed" ? "landing outcome unconfirmed" : outcome}${accuracy === "localized" ? "" : ` · ${accuracy} location`}`,
  }),
);
