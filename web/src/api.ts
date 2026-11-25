export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | null;

  constructor(status: number, code: string, field: string | null) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

export interface Health {
  ok: boolean;
  lastPollTs: number | null;
  lastPollOk: number | null;
  feedStale: boolean;
  aircraftNow: number;
}

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

export interface Airport {
  iata: string;
  name: string;
}

export interface TailInfo {
  reg: string | null;
  status: string;
  adjusted: boolean;
}

export interface Candidate {
  flightNo: string;
  airline: string | null;
  airlineName: string | null;
  bookingUrl: string | null;
  score: number;
  n: number;
  p10: number;
  p50: number;
  p90: number;
  safeBy: string;
  tail: TailInfo;
}

export interface InsufficientFlight {
  flightNo: string;
  n: number;
}

export interface SearchResponse {
  origin: string;
  dest: string;
  date: string;
  at: string;
  generatedAt: string | null;
  dataAsOf: string | null;
  feedStale: boolean;
  candidates: Candidate[];
  insufficient: InsufficientFlight[];
}

export interface FlightSample {
  dateWat: string;
  timeWat: string;
  weekday: boolean;
}

export interface FlightHistory {
  flt: string;
  origin: string | null;
  dest: string | null;
  samples: FlightSample[];
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let field: string | null = null;
    try {
      const body = (await res.json()) as { error?: unknown; field?: unknown };
      if (body && typeof body.error === 'string') code = body.error;
      if (typeof body.field === 'string') field = body.field;
    } catch {
      /* body was not JSON; keep the status-derived code */
    }
    throw new ApiError(res.status, code, field);
  }
  return (await res.json()) as T;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_airport: 'Pick an origin and destination from the airport list, and make sure they differ.',
  invalid_date: 'Pick a date from today up to 60 days ahead (WAT).',
  invalid_time: 'Pick a time between 00:00 and 23:59.',
};

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (ERROR_MESSAGES[err.code]) return ERROR_MESSAGES[err.code];
    if (err.status >= 500) return 'The server hit an error. Try again shortly.';
    return `Request failed (${err.status}).`;
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return 'Request cancelled.';
  }
  return 'Could not reach the API. Is the server running?';
}
