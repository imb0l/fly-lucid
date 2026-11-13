import { setTimeout as delay } from 'node:timers/promises';

import type { Db } from '../db/db.js';
import { FEED_URL, FeedError, fetchSnapshot } from '../feed/fr24.js';
import { applySnapshot } from './legs.js';

export const DEFAULT_POLL_MS = 30_000;
export const MAX_BACKOFF_MS = 600_000;

export interface PollerOptions {
  db: Db;
  feedUrl?: string;
  pollMs?: number;
  signal?: AbortSignal;
}

/**
 * Poll the feed forever until `signal` aborts. Successful polls are at least
 * `pollMs` apart; consecutive failures back off exponentially up to 10 minutes.
 */
export async function runPoller(options: PollerOptions): Promise<void> {
  const { db, feedUrl = FEED_URL, pollMs = DEFAULT_POLL_MS, signal } = options;
  if (!Number.isFinite(pollMs) || pollMs <= 0) {
    throw new Error(`invalid POLL_MS: ${String(pollMs)}`);
  }
  const airports = db.prepare<[], { n: number }>('SELECT count(*) AS n FROM airports').get();
  if (airports?.n === 0) {
    throw new Error('airports table is empty: import the airport reference data before starting the poller');
  }

  const logPoll = db.prepare<[number, number, number | null, string | null]>(
    'INSERT INTO poll_log (ts, ok, aircraft, error) VALUES (?, ?, ?, ?)',
  );
  const isAborted = (): boolean => signal?.aborted === true;

  let failures = 0;

  while (!isAborted()) {
    const startedAt = Date.now();
    const abortFetch = new AbortController();
    const forwardAbort = (): void => abortFetch.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    let delayMs = pollMs;

    try {
      const aircraft = await fetchSnapshot(feedUrl, abortFetch.signal);
      const nowSec = Math.floor(Date.now() / 1000);
      applySnapshot(db, aircraft, nowSec);
      logPoll.run(nowSec, 1, aircraft.length, null);
      failures = 0;
    } catch (error) {
      if (isAborted()) {
        break;
      }
      failures += 1;
      const kind = error instanceof FeedError ? error.kind : 'error';
      const message = error instanceof Error ? error.message : String(error);
      logPoll.run(Math.floor(Date.now() / 1000), 0, null, `${kind}: ${message}`);
      // The first failure retries after one interval, then the backoff doubles.
      delayMs = Math.min(pollMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
    } finally {
      signal?.removeEventListener('abort', forwardAbort);
    }

    try {
      await delay(Math.max(delayMs - (Date.now() - startedAt), 0), undefined, { signal });
    } catch {
      // Aborted while sleeping: the while condition ends the loop.
    }
  }
}
