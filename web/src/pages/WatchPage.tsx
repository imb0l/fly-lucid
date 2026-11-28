import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeError, getJson, type SearchResponse } from '../api';
import { fmtMinutesOfDay, fmtPercent, fmtWatClock, fmtWatDate, todayWat } from '../format';
import {
  getWatchlistStorageError,
  loadWatchlist,
  removePastWatchItems,
  removeWatchItem,
  watchKey,
  type WatchItem,
} from '../watchlist';

interface RowState {
  status: 'loading' | 'ok' | 'missing' | 'error' | 'stale';
  score?: number;
  n?: number;
  p10?: string;
  p50?: string;
  p90?: string;
  tailStatus?: string;
  adjusted?: boolean;
  feedStale?: boolean;
  message?: string;
}

const TAIL_LABELS: Record<string, string> = {
  inbound: 'Inbound aircraft',
  inbound_other_day: 'Inbound, arrives another day',
  landed_inbound: 'Inbound, already landed',
  not_inbound: 'Aircraft not inbound',
  unknown: 'Unknown',
};

const AUTO_REFRESH_MS = 60_000;

export default function WatchPage() {
  const [items, setItems] = useState<WatchItem[]>(() => loadWatchlist());
  const [storageError, setStorageError] = useState<string | null>(() => getWatchlistStorageError());
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [tick, setTick] = useState(0);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Mirror rows so an items change (e.g. a removal) can skip refetching rows
  // that already have data instead of reloading the whole watchlist.
  const rowsRef = useRef<Record<string, RowState>>({});
  const itemsRef = useRef<WatchItem[]>(items);
  const loadedTickRef = useRef(-1);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (items.length === 0) {
      loadedTickRef.current = tick;
      setRows({});
      setRefreshing(false);
      return;
    }

    // A tick bump is a manual or automatic refresh: reload every row. A pure
    // items change (removal) only loads rows without data yet.
    const forceAll = loadedTickRef.current !== tick;
    loadedTickRef.current = tick;
    const toLoad = forceAll
      ? items
      : items.filter((item) => {
          const row = rowsRef.current[watchKey(item)];
          return row === undefined || row.status === 'loading';
        });
    if (toLoad.length === 0) {
      setRefreshing(false);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setCheckFailed(false);
    // Keep previously fetched rows on screen while the refresh is in flight.
    setRows((previous) => {
      let changed = false;
      const next: Record<string, RowState> = { ...previous };
      for (const item of toLoad) {
        const key = watchKey(item);
        if (next[key] !== undefined) continue;
        next[key] = { status: 'loading' };
        changed = true;
      }
      return changed ? next : previous;
    });

    const load = async (): Promise<void> => {
      const today = todayWat();
      const fresh = await Promise.all(
        toLoad.map(async (item): Promise<[string, RowState]> => {
          const key = watchKey(item);
          if (item.date < today) {
            return [key, { status: 'stale', message: 'Date has passed — remove it.' }];
          }
          try {
            const query = new URLSearchParams({
              origin: item.origin,
              dest: item.dest,
              date: item.date,
              at: item.at,
            });
            const data = await getJson<SearchResponse>(`/api/search?${query.toString()}`, controller.signal);
            const candidate = data.candidates.find((c) => c.flightNo === item.flightNo);
            if (!candidate) {
              const insufficient = data.insufficient.find((entry) => entry.flightNo === item.flightNo);
              return [
                key,
                insufficient
                  ? {
                      status: 'missing',
                      message: `Only ${insufficient.n} observed departure${insufficient.n === 1 ? '' : 's'} in 28 days.`,
                    }
                  : { status: 'missing', message: 'Not in the current forecast.' },
              ];
            }
            return [
              key,
              {
                status: 'ok',
                score: candidate.score,
                n: candidate.n,
                p10: candidate.p10,
                p50: candidate.p50,
                p90: candidate.p90,
                tailStatus: candidate.tail.status,
                adjusted: candidate.tail.adjusted,
                feedStale: data.feedStale,
              },
            ];
          } catch (err) {
            return [key, { status: 'error', message: describeError(err) }];
          }
        }),
      );

      if (cancelled) return;
      const results: Record<string, RowState> = {};
      for (const [key, state] of fresh) results[key] = state;
      setRows((previous) => {
        const currentItems = itemsRef.current;
        const currentKeys = new Set(currentItems.map(watchKey));
        const merged: Record<string, RowState> = { ...previous };
        for (const item of currentItems) {
          const key = watchKey(item);
          merged[key] = results[key] ?? previous[key] ?? { status: 'loading' as const };
        }
        for (const key of Object.keys(merged)) {
          if (!currentKeys.has(key)) delete merged[key];
        }
        return merged;
      });
      const anyOk = fresh.some(([, state]) => state.status === 'ok');
      setCheckedAt(anyOk ? Date.now() / 1000 : null);
      setCheckFailed(!anyOk);
      setRefreshing(false);
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [items, tick]);

  // Auto-refresh while the tab is visible; paused when hidden and resumed
  // (immediately) when it becomes visible again.
  useEffect(() => {
    const refresh = (): void => setTick((value) => value + 1);
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, AUTO_REFRESH_MS);
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  function dropRows(keys: Iterable<string>): void {
    const removed = new Set(keys);
    setRows((previous) => {
      const next: Record<string, RowState> = {};
      for (const [key, row] of Object.entries(previous)) {
        if (!removed.has(key)) next[key] = row;
      }
      return next;
    });
  }

  function onRemove(item: WatchItem): void {
    const key = watchKey(item);
    setItems(removeWatchItem(item));
    dropRows([key]);
    setStorageError(getWatchlistStorageError());
  }

  const today = todayWat();
  const pastItems = items.filter((item) => item.date < today);

  function onRemovePast(): void {
    if (pastItems.length === 0) return;
    setItems(removePastWatchItems(items, today));
    dropRows(pastItems.map(watchKey));
    setStorageError(getWatchlistStorageError());
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Watchlist</h1>
          <p className="muted">
            Saved in this browser only. Scores refresh when you open this page and every minute while it is visible.
          </p>
        </div>
        <div className="page-actions">
          {refreshing && (
            <span className="muted small" role="status">
              Updating…
            </span>
          )}
          {checkFailed ? (
            <span className="muted small" role="alert">Check failed</span>
          ) : checkedAt ? (
            <span className="muted small">Checked at {fmtWatClock(checkedAt)} WAT</span>
          ) : null}
          {pastItems.length > 0 && (
            <button type="button" className="btn" onClick={onRemovePast}>
              Remove past dates ({pastItems.length})
            </button>
          )}
          <button type="button" className="btn" onClick={() => setTick((value) => value + 1)}>
            Refresh scores
          </button>
        </div>
      </div>

      {storageError && (
        <p className="banner banner-error" role="alert">
          {storageError}
        </p>
      )}

      {items.length === 0 ? (
        <div className="card empty">
          <p>Nothing saved yet.</p>
          <p>
            Run a forecast on the <Link to="/find">Find a flight</Link> page and use “Save to watchlist”.
          </p>
        </div>
      ) : (
        <div className="card">
          <div className="table-scroll">
            <table className="results">
              <thead>
                <tr>
                  <th scope="col">Route</th>
                  <th scope="col">Date</th>
                  <th scope="col">Leave at</th>
                  <th scope="col">Flight</th>
                  <th scope="col">Current score</th>
                  <th scope="col">Likely window</th>
                  <th scope="col">Samples</th>
                  <th scope="col">Tail status</th>
                  <th scope="col">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const row = rows[watchKey(item)] ?? { status: 'loading' as const };
                  return (
                    <tr key={watchKey(item)}>
                      <td>
                        {item.origin} → {item.dest}
                      </td>
                      <td>{fmtWatDate(item.date)}</td>
                      <td>{item.at}</td>
                      <td>
                        <Link
                          className="flight-link"
                          to={`/flight/${encodeURIComponent(item.flightNo)}?origin=${encodeURIComponent(
                            item.origin,
                          )}&dest=${encodeURIComponent(item.dest)}`}
                        >
                          {item.flightNo}
                        </Link>
                      </td>
                      <td className="num">
                        {row.status === 'ok' ? fmtPercent(row.score) : row.status === 'loading' ? '…' : '—'}
                        {(row.status === 'error' || row.status === 'stale' || row.status === 'missing') && (
                          <div className="muted small">{row.message}</div>
                        )}
                      </td>
                      <td>
                        {row.status === 'ok' ? (
                          <>
                            <div>
                              {fmtMinutesOfDay(row.p10)}–{fmtMinutesOfDay(row.p90)}
                            </div>
                            {row.p50 !== undefined && (
                              <div className="muted small">median {fmtMinutesOfDay(row.p50)}</div>
                            )}
                            {row.feedStale && (
                              <div className="muted small">Live feed stale — tail status unavailable; window uses 28-day history.</div>
                            )}
                          </>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="num">{row.status === 'ok' ? row.n : '—'}</td>
                      <td>
                        {row.status === 'ok' ? (
                          <>
                            <div>{TAIL_LABELS[row.tailStatus ?? ''] ?? row.tailStatus}</div>
                            {row.adjusted && <div className="muted small">takeoff floored</div>}
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        <button type="button" className="btn btn-small" onClick={() => onRemove(item)}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
