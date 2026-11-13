// Airline display names and booking URLs, keyed by the ICAO carrier code that
// appears in the FR24 feed's `airline` field (e.g. APO, THY, ARA, ETH).
//
// Intentionally empty: this map is populated in Step 9 from the airline codes
// actually observed in the live feed, after each booking URL is confirmed in a
// browser. Unknown codes resolve to `null` at render time; do not guess URLs.

export interface AirlineInfo {
  name: string;
  bookingUrl: string | null;
}

export const AIRLINES: Record<string, AirlineInfo> = {};
