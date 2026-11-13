// Airline display names and booking URLs, keyed by the ICAO carrier code that
// appears in the FR24 feed's `airline` field (e.g. APO, THY, ARA, ETH).
//
// Populated from the airline ICAO codes observed in the live Nigeria FR24 feed.
// Unknown codes resolve to `null` at render time; charter/private operators
// without a consumer booking page have `bookingUrl: null`.

export interface AirlineInfo {
  name: string;
  bookingUrl: string | null;
}

export const AIRLINES: Record<string, AirlineInfo> = {
  APO: { name: 'Air Peace', bookingUrl: 'https://flyairpeace.com/' },
  IAN: { name: 'Ibom Air', bookingUrl: 'https://www.ibomair.com/' },
  GWG: { name: 'Green Africa Airways', bookingUrl: 'https://greenafrica.com/' },
  NUA: { name: 'United Nigeria Airlines', bookingUrl: 'https://flyunitednigeria.com/' },
  NGL: { name: 'Max Air', bookingUrl: 'https://maxair.com.ng/' },
  NVD: { name: 'Avion Express', bookingUrl: null },
  FBM: { name: 'Flying Bulls', bookingUrl: null },
  THY: { name: 'Turkish Airlines', bookingUrl: 'https://www.turkishairlines.com/' },
  ETH: { name: 'Ethiopian Airlines', bookingUrl: 'https://www.ethiopianairlines.com/' },
  DLH: { name: 'Lufthansa', bookingUrl: 'https://www.lufthansa.com/' },
  UAE: { name: 'Emirates', bookingUrl: 'https://www.emirates.com/' },
  SAA: { name: 'South African Airways', bookingUrl: 'https://www.flysaa.com/' },
  RWD: { name: 'RwandAir', bookingUrl: 'https://www.rwandair.com/' },
  KQA: { name: 'Kenya Airways', bookingUrl: 'https://www.kenya-airways.com/' },
  ATC: { name: 'Air Tanzania', bookingUrl: 'https://www.airtanzania.co.tz/' },
  AFR: { name: 'Air France', bookingUrl: 'https://www.airfrance.com/' },
  WRC: { name: 'Windrose Airlines', bookingUrl: null },
};
