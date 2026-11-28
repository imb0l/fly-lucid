import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { describeError, getJson, type Airport, type Candidate, type SearchResponse } from '../api';
import { addWatchItem, getWatchlistStorageError, loadWatchlist, watchKey } from '../watchlist';
import { addDaysWat, fmtMinutesOfDay, fmtPercent, fmtWatDate, fmtWatTimestamp, todayWat } from '../format';

const TAIL_LABELS: Record<string, string> = {
  inbound: 'Inbound aircraft',
  inbound_other_day: 'Inbound, arrives another day',
  landed_inbound: 'Inbound, already landed',
  not_inbound: 'Aircraft not inbound',
  unknown: 'Unknown',
};

const DISCLAIMER = 'Based on observed departures over the last 28 days. Not an airline schedule.';

export default function FindPage() {
  const [airports, setAirports] = useState<Airport[] | null>(null);
  const [airportsError, setAirportsError] = useState<string | null>(null);
  const [airportsLoading, setAirportsLoading] = useState(true);
  const [airportsAttempt, setAirportsAttempt] = useState(0);
  const [origin, setOrigin] = useState('');
  const [dest, setDest] = useState('');
  const [date, setDate] = useState(todayWat);
  const [at, setAt] = useState('14:00');
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [savedKeys, setSavedKeys] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setAirportsLoading(true);
    setAirportsError(null);
    getJson<Airport[]>('/api/airports', controller.signal)
      .then((list) => {
        if (cancelled) return;
        setAirports(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setAirportsError(describeError(err));
      })
      .finally(() => {
        if (!cancelled) setAirportsLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [airportsAttempt]);

  const sortedAirports = useMemo(
    () => (airports ? [...airports].sort((a, b) => a.iata.localeCompare(b.iata)) : []),
    [airports],
  );

  const savedSet = useMemo(() => new Set(savedKeys), [savedKeys]);

  function onSave(candidate: Candidate): void {
    if (!result) return;
    const item = {
      origin: result.origin,
      dest: result.dest,
      date: result.date,
      at: result.at,
      flightNo: candidate.flightNo,
    };
    addWatchItem(item);
    setStorageError(getWatchlistStorageError());
    setSavedKeys(loadWatchlist().map(watchKey));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!origin || !dest) {
      setError('Pick both an origin and a destination.');
      return;
    }
    if (origin === dest) {
      setError('Origin and destination must differ.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const query = new URLSearchParams({ origin, dest, date, at });
      const data = await getJson<SearchResponse>(`/api/search?${query.toString()}`);
      setResult(data);
      setSavedKeys(loadWatchlist().map(watchKey));
    } catch (err) {
      setResult(null);
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Want to leave at a certain time?</h1>
          <p className="muted">
            Rank the flights on a route by how often their <em>actual</em> takeoff landed in the 30 minutes before and
            60 minutes after your time.
          </p>
        </div>
      </div>

      <form className="card form-card" onSubmit={onSubmit}>
        <div className="form-grid">
          <label className="field">
            <span>From</span>
            <select value={origin} onChange={(e) => setOrigin(e.target.value)} disabled={!airports || airportsLoading}>
              <option value="">{airports ? 'Select origin' : airportsLoading ? 'Loading airports…' : 'Airports unavailable'}</option>
              {sortedAirports.map((airport) => (
                <option key={airport.iata} value={airport.iata}>
                  {airport.iata} — {airport.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>To</span>
            <select value={dest} onChange={(e) => setDest(e.target.value)} disabled={!airports || airportsLoading}>
              <option value="">{airports ? 'Select destination' : airportsLoading ? 'Loading airports…' : 'Airports unavailable'}</option>
              {sortedAirports.map((airport) => (
                <option key={airport.iata} value={airport.iata}>
                  {airport.iata} — {airport.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Date (WAT)</span>
            <input
              type="date"
              value={date}
              min={todayWat()}
              max={addDaysWat(todayWat(), 60)}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Leave at (WAT)</span>
            <input type="time" value={at} onChange={(e) => setAt(e.target.value)} required />
          </label>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !airports}>
            {busy ? 'Searching…' : 'Forecast takeoff'}
          </button>
          {airportsError && (
            <span className="form-error" role="alert">
              Airports unavailable: {airportsError}{' '}
              <button
                type="button"
                className="btn btn-small"
                onClick={() => setAirportsAttempt((attempt) => attempt + 1)}
                disabled={airportsLoading}
              >
                {airportsLoading ? 'Retrying…' : 'Retry'}
              </button>
            </span>
          )}
          {error && (
            <span className="form-error" role="alert">
              {error}
            </span>
          )}
        </div>
      </form>

      <p className="disclaimer">{DISCLAIMER}</p>

      {storageError && (
        <p className="banner banner-error" role="alert">
          {storageError}
        </p>
      )}

      <div aria-live="polite">
        {result && (
          <section className="card">
            <div className="card-head">
              <h2>
                {result.origin} → {result.dest} · {fmtWatDate(result.date)} · leaving at {result.at} WAT
              </h2>
              {result.feedStale && <span className="pill pill-warn">Live feed stale</span>}
            </div>

            <p className="small muted">Data current to {fmtWatTimestamp(result.dataAsOf)}</p>
            {result.feedStale && (
              <p className="hint">
                The live feed is stale, so current tail status is unavailable. Takeoff windows use the 28-day departure
                history only.
              </p>
            )}

            {result.candidates.length === 0 ? (
              <div className="empty">
                {result.insufficient.length === 0 ? (
                  <p>No flights were observed on this route in the last 28 days.</p>
                ) : (
                  <>
                    <p>No flight on this route can be forecast yet.</p>
                    <p>
                      A forecast needs at least <strong>5 observed departures</strong> per flight over the last 28 days.
                      That data is still building, so there is nothing to rank here yet.
                    </p>
                  </>
                )}
                {result.feedStale && (
                  <p>A stale live feed can hide flights that did operate, so this view may be incomplete.</p>
                )}
              </div>
            ) : (
              <div
                className="table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Forecast results table, scrollable"
              >
              <p className="hint">
                Takeoff estimates, not boarding times. The “Likely departed by” time is deliberately earlier than the likely
                window.
              </p>
              <table className="results">
                <thead>
                  <tr>
                    <th scope="col">Flight</th>
                    <th scope="col">Airline</th>
                    <th scope="col">Likely takeoff window</th>
                    <th scope="col">Chance of leaving in your window</th>
                    <th scope="col">Samples</th>
                    <th scope="col">Tail status</th>
                    <th scope="col">
                      <span className="sr-only">Watchlist</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.candidates.map((candidate) => {
                    const tailLabel = TAIL_LABELS[candidate.tail.status] ?? candidate.tail.status;
                    return (
                      <tr key={candidate.flightNo}>
                        <td>
                          <Link
                            className="flight-link"
                            to={`/flight/${encodeURIComponent(candidate.flightNo)}?origin=${encodeURIComponent(
                              result.origin,
                            )}&dest=${encodeURIComponent(result.dest)}`}
                          >
                            {candidate.flightNo}
                          </Link>
                        </td>
                        <td>
                          <div>{candidate.airlineName ?? candidate.airline ?? 'Unknown airline'}</div>
                          {candidate.bookingUrl && (
                            <a
                              className="booking-link"
                              href={candidate.bookingUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Book on {candidate.airlineName ?? candidate.airline}
                            </a>
                          )}
                        </td>
                        <td>
                          <div>Expected ~{fmtMinutesOfDay(candidate.p50)}</div>
                          <div className="small muted">
                            {fmtMinutesOfDay(candidate.p10)}–{fmtMinutesOfDay(candidate.p90)}
                          </div>
                          {candidate.safeBy && (
                            <div className="small">
                              <span className="pill">Likely departed by {fmtMinutesOfDay(candidate.safeBy)}</span>
                            </div>
                          )}
                        </td>
                        <td className="num">{fmtPercent(candidate.score)}</td>
                        <td className="num">{candidate.n}</td>
                        <td>
                          <div>{tailLabel}</div>
                          {candidate.tail.reg && (
                            <div className="muted small">
                              {candidate.tail.reg}
                              {candidate.tail.adjusted ? ' · takeoff floored' : ''}
                            </div>
                          )}
                        </td>
                        <td>
                          {savedSet.has(
                            watchKey({
                              origin: result.origin,
                              dest: result.dest,
                              date: result.date,
                              at: result.at,
                              flightNo: candidate.flightNo,
                            }),
                          ) ? (
                            <span className="pill pill-ok">Saved</span>
                          ) : (
                            <button type="button" className="btn btn-small" onClick={() => onSave(candidate)}>
                              Save to watchlist
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {result.insufficient.length > 0 && (
            <div className="insufficient">
              <h3>Too few observations to forecast</h3>
              <ul>
                {result.insufficient.map((flight) => (
                  <li key={flight.flightNo}>
                    <code>{flight.flightNo}</code> — {flight.n} departure{flight.n === 1 ? '' : 's'} observed
                  </li>
                ))}
              </ul>
            </div>
          )}
          </section>
        )}
      </div>
    </section>
  );
}
