# fly-lucid

Live Nigerian flight tracking plus an observed-departure forecast. The poller reads FlightRadar24's public feed, derives DEP/ARR events for Nigerian airports, and the forecast is computed from those observed events over the last 28 days. It is not an airline schedule.

## Layout

- `server/` Node 22, TypeScript ESM. Poller (`src/poller-main.ts`), API (`src/api-main.ts`), SQLite via better-sqlite3.
- `web/` Vite + React 19 + MapLibre. Pages: Live map, Find, Watchlist, Flight history.
- `server/data/ng-airports.json` committed airport reference data, loaded at startup.

## Run locally

```sh
pnpm install
pnpm build            # server (tsc) + web (vite)
pnpm test             # server unit + replay tests

pnpm -C server poller # node dist/poller-main.js
pnpm -C server api    # node dist/api-main.js, serves web/dist if present
pnpm -C web dev       # Vite dev server, proxies /api to :8787
```

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `DB_PATH` | `./data/fly.db` | poller, API |
| `PORT` | `8787` | API |
| `POLL_MS` | `30000` | poller |
| `FEED_URL` | built-in FR24 query | poller |
| `WEB_DIST` | `web/dist` relative to repo root | API |
| `VITE_MAP_STYLE_URL` | OpenFreeMap liberty style | web build |

The poller backs off exponentially on consecutive failures (first retry after one interval, then doubling) up to 10 minutes.

## API

- `GET /api/health` poll status, `feedStale` (no successful poll for more than 180 s).
- `GET /api/live` aircraft seen in the last 120 s, 5 s server cache.
- `GET /api/airports` IATA, name.
- `GET /api/search?origin=&dest=&date=YYYY-MM-DD&at=HH:MM` WAT. Date must be today WAT through today + 60 days. Returns candidates with p10/p50/p90 departure times, score, sample count, tail-aircraft status, and an `insufficient` list for flights with fewer than 5 observed departures.
Validation errors return `{"error": "invalid_airport" | "invalid_date" | "invalid_time", "field"?}` with HTTP 400.

## Docker

```sh
docker compose up -d --build
```

Two services share `./data`: `poller` writes, `api` reads and serves the built web app on `http://localhost:8787`. The poller is started before the API.

## Notes

- Forecast candidates only appear once a route/flight has at least 5 observed departures in the window. Early after startup the candidate list is empty by design.
- The FR24 feed is unofficial. Its response shape can change without notice; the parser skips malformed rows rather than failing the poll.
