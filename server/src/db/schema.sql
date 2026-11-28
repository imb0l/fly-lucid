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
  sched_ts INTEGER,
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

CREATE INDEX IF NOT EXISTS poll_log_ok_ts ON poll_log(ok, ts);

-- Point-in-time forecast audit: one row per candidate returned by /api/search,
-- storing raw model output before any later calibration.
CREATE TABLE IF NOT EXISTS forecast_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  forecast_key TEXT NOT NULL UNIQUE,
  issued_at INTEGER NOT NULL,
  target_ts INTEGER NOT NULL,
  target_date TEXT NOT NULL,
  horizon_min INTEGER,
  flt TEXT NOT NULL,
  airline TEXT,
  origin TEXT NOT NULL,
  dest TEXT NOT NULL,
  at_min INTEGER,
  p10 INTEGER,
  p50 INTEGER,
  p90 INTEGER,
  safe_by INTEGER,
  n INTEGER,
  score REAL,
  tail_reg TEXT,
  tail_status TEXT,
  tail_adjusted INTEGER,
  feed_stale INTEGER,
  event_max_id INTEGER,
  model_version TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS forecast_log_target ON forecast_log(target_date, flt);
CREATE INDEX IF NOT EXISTS forecast_log_model ON forecast_log(model_version, target_date);

-- Resolved actuals for a logged forecast; unscored forecasts have no row.
CREATE TABLE IF NOT EXISTS forecast_outcome (
  forecast_id INTEGER PRIMARY KEY REFERENCES forecast_log(id),
  actual_ts INTEGER,
  actual_min INTEGER,
  residual_min INTEGER,
  in_interval INTEGER,
  early INTEGER,
  outcome TEXT,
  matched_by TEXT,
  scored_at INTEGER
);

CREATE INDEX IF NOT EXISTS forecast_outcome_outcome ON forecast_outcome(outcome);
