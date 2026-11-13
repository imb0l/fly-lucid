CREATE TABLE IF NOT EXISTS airports (
  iata TEXT PRIMARY KEY,
  icao TEXT,
  name TEXT NOT NULL,
  lat REAL,
  lon REAL
);

CREATE TABLE IF NOT EXISTS aircraft_state (
  hex TEXT PRIMARY KEY,
  reg TEXT,
  type TEXT,
  flt TEXT,
  airline TEXT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  alt_ft INTEGER,
  gs_kt INTEGER,
  hdg INTEGER,
  on_ground INTEGER NOT NULL,
  orig TEXT,
  dest TEXT,
  ts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS aircraft_state_reg ON aircraft_state(reg);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hex TEXT NOT NULL,
  reg TEXT,
  flt TEXT,
  airline TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('DEP','ARR')),
  airport TEXT NOT NULL,
  dest TEXT,
  ts INTEGER NOT NULL,
  UNIQUE(hex, kind, ts)
);

CREATE INDEX IF NOT EXISTS events_lookup ON events(kind, airport, flt, ts);
CREATE INDEX IF NOT EXISTS events_airport_ts ON events(airport, kind, ts);

CREATE TABLE IF NOT EXISTS poll_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  aircraft INTEGER,
  error TEXT
);
