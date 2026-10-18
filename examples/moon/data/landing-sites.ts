import type { MarkerCountry } from "./marker-countries.ts";

export type Place = {
  name: string;
  latitudeDeg: number;
  longitudeDeg: number;
  kind?: "landing" | "impact" | "landmark";
  detail?: string;
  sourceUrl?: string;
  accuracy?: "localized" | "approximate" | "unconfirmed";
  country?: MarkerCountry;
};

// Lunar Module coordinates, Mean Earth / polar axis, DE421.
// NSSDC planetary/lunar/lunar_sites.html. Apollo 13 did not land.
export const APOLLO_LANDING_SITES: readonly Place[] = [
  { name: "Apollo 11", latitudeDeg: 0.67416, longitudeDeg: 23.47314, country: "US" },
  { name: "Apollo 12", latitudeDeg: -3.0128, longitudeDeg: -23.4219, country: "US" },
  { name: "Apollo 14", latitudeDeg: -3.64589, longitudeDeg: -17.47194, country: "US" },
  { name: "Apollo 15", latitudeDeg: 26.13239, longitudeDeg: 3.6333, country: "US" },
  { name: "Apollo 16", latitudeDeg: -8.9734, longitudeDeg: 15.5011, country: "US" },
  { name: "Apollo 17", latitudeDeg: 20.1911, longitudeDeg: 30.7723, country: "US" },
];
