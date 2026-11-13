import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { describeError, getJson, type FlightHistory } from '../api';
import { fmtWatDate } from '../format';

type LoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'ok'; data: FlightHistory }
  | { status: 'error'; message: string };

export default function FlightPage() {
  const { flt } = useParams<{ flt: string }>();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const origin = params.get('origin') ?? '';
  const dest = params.get('dest') ?? '';
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [form, setForm] = useState({ flt: '', origin: '', dest: '' });

  useEffect(() => {
    if (!flt) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState({ status: 'loading' });
    const query = new URLSearchParams();
    if (origin) query.set('origin', origin);
    if (dest) query.set('dest', dest);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    getJson<FlightHistory>(`/api/flights/${encodeURIComponent(flt)}${suffix}`, controller.signal)
      .then((data) => {
        if (!cancelled) setState({ status: 'ok', data });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ status: 'error', message: describeError(err) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [flt, origin, dest]);

  const samples = useMemo(() => {
    if (state.status !== 'ok') return [];
    return [...state.data.samples].sort((a, b) =>
      `${b.dateWat} ${b.timeWat}`.localeCompare(`${a.dateWat} ${a.timeWat}`),
    );
  }, [state]);

  function onLookup(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const wanted = form.flt.trim().toUpperCase();
    if (!wanted) return;
    const query = new URLSearchParams();
    const from = form.origin.trim().toUpperCase();
    const to = form.dest.trim().toUpperCase();
    if (from) query.set('origin', from);
    if (to) query.set('dest', to);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    navigate(`/flight/${encodeURIComponent(wanted)}${suffix}`);
  }

  if (!flt) {
    return (
      <section className="page">
        <div className="page-head">
          <div>
            <h1>Flight history</h1>
            <p className="muted">Every observed departure for a flight in the last 28 days.</p>
          </div>
        </div>
        <form className="card form-card" onSubmit={onLookup}>
          <div className="form-grid">
            <label className="field">
              <span>Flight number</span>
              <input
                type="text"
                value={form.flt}
                placeholder="e.g. P47443"
                onChange={(e) => setForm({ ...form, flt: e.target.value })}
                required
              />
            </label>
            <label className="field">
              <span>Origin (optional)</span>
              <input
                type="text"
                value={form.origin}
                placeholder="e.g. LOS"
                maxLength={3}
                onChange={(e) => setForm({ ...form, origin: e.target.value })}
              />
            </label>
            <label className="field">
              <span>Destination (optional)</span>
              <input
                type="text"
                value={form.dest}
                placeholder="e.g. ABV"
                maxLength={3}
                onChange={(e) => setForm({ ...form, dest: e.target.value })}
              />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">
              Load history
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>
            {flt}
            {origin && dest ? ` · ${origin} → ${dest}` : ''}
          </h1>
          <p className="muted">Observed departure times over the last 28 days. Scheduled times are not stored.</p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/find">
            Back to forecast
          </Link>
        </div>
      </div>

      {state.status === 'loading' && <p className="muted">Loading observations…</p>}
      {state.status === 'error' && <p className="banner banner-error">{state.message}</p>}

      {state.status === 'ok' && (
        <div className="card">
          <div className="card-head">
            <h2>
              {samples.length} observed departure{samples.length === 1 ? '' : 's'}
            </h2>
          </div>
          {samples.length === 0 ? (
            <div className="empty">
              <p>No observed departures stored for this flight yet.</p>
              <p>The poller only records departures it sees in the live feed, so a quiet flight will stay empty.</p>
            </div>
          ) : (
            <div className="table-scroll">
              <table className="results">
                <thead>
                  <tr>
                    <th scope="col">Date (WAT)</th>
                    <th scope="col">Actual departure (WAT)</th>
                    <th scope="col">Day</th>
                  </tr>
                </thead>
                <tbody>
                  {samples.map((sample, index) => (
                    <tr key={`${sample.dateWat}T${sample.timeWat}-${index}`}>
                      <td>{fmtWatDate(sample.dateWat)}</td>
                      <td>{sample.timeWat}</td>
                      <td>{sample.weekday ? 'Weekday' : 'Weekend'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
