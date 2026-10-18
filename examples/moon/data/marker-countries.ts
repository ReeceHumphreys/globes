export const MARKER_COUNTRIES = [
  { id: "US", name: "United States", flag: "🇺🇸", label: "US" },
  { id: "SU", name: "Soviet Union", flag: "☭", label: "USSR" },
  { id: "RU", name: "Russia", flag: "🇷🇺", label: "RU" },
  { id: "CN", name: "China", flag: "🇨🇳", label: "CN" },
  { id: "IN", name: "India", flag: "🇮🇳", label: "IN" },
  { id: "JP", name: "Japan", flag: "🇯🇵", label: "JP" },
  { id: "IL", name: "Israel", flag: "🇮🇱", label: "IL" },
] as const;

export type MarkerCountry = (typeof MARKER_COUNTRIES)[number]["id"];
