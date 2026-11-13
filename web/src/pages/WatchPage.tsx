import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeError, getJson, type SearchResponse } from '../api';
import { fmtMinutesOfDay, fmtPercent, fmtWatClock, fmtWatDate, todayWat } from '../format';
import { loadWatchlist, removeWatchItem, watchKey, type WatchItem } from '../watchlist';

interface RowState {
  status: 'loading' | 'ok' | 'missing' | 'error' | 'stale';
  score?: number;
  n?: number;
  p10?: number;
  p50?: number;
  p90?: number;
  tailStatus?: string;
  adjusted?: boolean;
  message?: string;
}

const TAIL_LABELS: Record<string, string> = {
  inbound: 'Inbound aircraft',
  inbound_other_day: 'Inbound, arrives another day',
  not_inbound: 'Aircraft not inbound',
  unknown: 'Unknown',
};

export default function WatchPage() {
  const [items, setItems] = useState<WatchItem[]>(loadWatchlist);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [tick, setTick] = useState(0);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  useEffect(() => {
    if (items.length === 0) {
      setRows({});
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    const pending: Record<string, RowState> = {};
    for (const item of items) pending[watchKey(item)] = { status: 'loading' };
    setRows(pending);

    const load = async (): Promise<void> => {
      const next: Record<string, RowState> = {};
      const today = todayWat();
      await Promise.all(
        items.map(async (item) => {
          const key = watchKey(item);
          if (item.date < today) {
            next[key] = { status: 'stale', message: 'Date has passed — remove it.' };
            return;
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
            next[key] = candidate
              ? {
                  status: 'ok',
                  score: candidate.score,
                  n: candidate.n,
                  p10: candidate.p10,
                  p50: candidate.p50,
                  p90: candidate.p90,
                  tailStatus: candidate.tail.status,
                  adjusted: candidate.tail.adjusted,
                }
              : { status: 'missing', message: 'Not in the current forecast — too few observations.' };
          } catch (err) {
            if (controller.signal.aborted) return;
            next[key] = { status: 'error', message: describeError(err) };
          }
        }),
      );
      if (!cancelled) {
        setRows(next);
        setCheckedAt(Date.now() / 1000);
      }
    };

    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [items, tick]);

  function onRemove(item: WatchItem): void {
    setItems(removeWatchItem(item));
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Watchlist</h1>
          <p className="muted">Saved in this browser only. Scores are re-checked every time you open this page.</p>
        </div>
        <div className="page-actions">
          {checkedAt && <span className="muted small">Checked at {fmtWatClock(checkedAt)} WAT</span>}
          <button type="button" className="btn" onClick={() => setTick((value) => value + 1)}>
            Refresh scores
          </button>
        </div>
      </div>

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
                      </td>
                      <td>
                        {row.status === 'ok' ? `${fmtMinutesOfDay(row.p10)}–${fmtMinutesOfDay(row.p90)}` : '—'}
                      </td>
                      <td className="num">{row.status === 'ok' ? row.n : '—'}</td>
                      <td>
                        {row.status === 'ok' ? (
                          <>
                            <div>{TAIL_LABELS[row.tailStatus ?? ''] ?? row.tailStatus}</div>
                            {row.adjusted && <div className="muted small">takeoff floored</div>}
                          </>
                        ) : (
                          <span className="muted small">{row.message ?? ''}</span>
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
