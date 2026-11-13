/** One aircraft observation parsed from the FlightRadar24 feed. */
export interface Aircraft {
  hex: string;
  reg: string | null;
  type: string | null;
  flt: string | null;
  airline: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  hdg: number | null;
  onGround: boolean;
  orig: string | null;
  dest: string | null;
  ts: number;
}
