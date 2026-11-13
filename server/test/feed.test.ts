import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BOUNDS, FEED_URL, FeedError, fetchSnapshot, parseSnapshot } from '../src/feed/fr24.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), 'utf8')) as unknown;
}

const snapshot1 = loadFixture('fr24-snapshot-1.json');
const snapshot2 = loadFixture('fr24-snapshot-2.json');

describe('parseSnapshot', () => {
  it('parses the first saved fixture with the documented index map', () => {
    const aircraft = parseSnapshot(snapshot1);

    expect(aircraft.length).toBeGreaterThan(0);
    expect(aircraft.some((a) => a.orig !== null)).toBe(true);
    expect(aircraft.some((a) => a.onGround)).toBe(true);
    expect(aircraft.some((a) => !a.onGround)).toBe(true);

    for (const a of aircraft) {
      expect(a.hex.length).toBeGreaterThan(0);
      expect(Number.isInteger(a.ts)).toBe(true);
      expect(a.lat).toBeGreaterThanOrEqual(BOUNDS.minLat);
      expect(a.lat).toBeLessThanOrEqual(BOUNDS.maxLat);
      expect(a.lon).toBeGreaterThanOrEqual(BOUNDS.minLon);
      expect(a.lon).toBeLessThanOrEqual(BOUNDS.maxLon);
    }
  });

  it('parses the second saved fixture', () => {
    const aircraft = parseSnapshot(snapshot2);

    expect(aircraft.length).toBeGreaterThan(0);
    expect(aircraft.some((a) => a.orig !== null)).toBe(true);
    expect(aircraft.some((a) => a.onGround)).toBe(true);
    expect(aircraft.some((a) => !a.onGround)).toBe(true);
  });

  it('keeps the observed fields of a known record', () => {
    const aircraft = parseSnapshot(snapshot1);
    const sample = aircraft.find((a) => a.reg === '5H-TCQ');

    expect(sample).toBeDefined();
    expect(sample?.hex).toBe('0800A0');
    expect(sample?.orig).toBe('ACC');
    expect(sample?.dest).toBe('DAR');
    expect(sample?.flt).toBe('TC235');
    expect(sample?.airline).toBe('ATC');
    expect(sample?.type).toBe('B39M');
    expect(sample?.altFt).toBe(35000);
    expect(sample?.gsKt).toBe(495);
    expect(sample?.onGround).toBe(false);
  });

  it('skips malformed records and aircraft outside the bounding box', () => {
    const row = (overrides: Record<number, unknown>) => {
      const base: unknown[] = new Array(19).fill('');
      base[0] = 'ABCDEF';
      base[1] = 6.5;
      base[2] = 3.3;
      base[3] = 90;
      base[4] = 1000;
      base[5] = 200;
      base[8] = 'B738';
      base[9] = '5N-TST';
      base[10] = 1_700_000_000;
      base[11] = 'LOS';
      base[12] = 'ABV';
      base[13] = 'P47443';
      base[14] = 1;
      base[18] = 'APO';
      for (const [index, value] of Object.entries(overrides)) {
        base[Number(index)] = value;
      }
      return base;
    };

    const aircraft = parseSnapshot({
      full_count: 2,
      version: 4,
      stats: { total: null },
      good: row({}),
      outside: row({ 0: 'OUTSID', 1: 30, 2: 3.3 }),
      emptyHex: row({ 0: '' }),
      short: ['ABCDEF', 6.5],
      notAnArray: 'nope',
      badTs: row({ 0: 'BADTS0', 10: 1.5 }),
      emptyStrings: row({ 0: 'EMPTY0', 9: '', 11: '', 12: '', 13: '', 18: '' }),
    });

    expect(aircraft.map((a) => a.hex)).toEqual(['ABCDEF', 'EMPTY0']);
    expect(aircraft[1]?.reg).toBeNull();
    expect(aircraft[1]?.orig).toBeNull();
    expect(aircraft[1]?.dest).toBeNull();
    expect(aircraft[1]?.flt).toBeNull();
    expect(aircraft[1]?.airline).toBeNull();
  });

  it('rejects a payload that is not an object', () => {
    expect(() => parseSnapshot(null)).toThrow(FeedError);
    expect(() => parseSnapshot([])).toThrow(FeedError);
    try {
      parseSnapshot('not-json');
    } catch (error) {
      expect(error).toBeInstanceOf(FeedError);
      expect((error as FeedError).kind).toBe('parse');
    }
  });
});

describe('fetchSnapshot', () => {
  let server: Server;
  let origin = '';
  let seenUserAgent: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenUserAgent = req.headers['user-agent'];
      if (req.url === '/challenge') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>Just a moment…</body></html>');
        return;
      }
      if (req.url === '/http-error') {
        res.writeHead(503);
        res.end('unavailable');
        return;
      }
      if (req.url === '/bad-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"broken":');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(snapshot1));
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('test server did not bind to a port');
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns parsed aircraft and sends the documented user agent', async () => {
    const aircraft = await fetchSnapshot(`${origin}/ok`);

    expect(aircraft.length).toBe(parseSnapshot(snapshot1).length);
    expect(seenUserAgent).toBe('Mozilla/5.0');
  });

  it('maps an HTML body to a challenge FeedError', async () => {
    await expect(fetchSnapshot(`${origin}/challenge`)).rejects.toMatchObject({
      name: 'FeedError',
      kind: 'challenge',
    });
  });

  it('maps a non-2xx response to an http FeedError', async () => {
    await expect(fetchSnapshot(`${origin}/http-error`)).rejects.toMatchObject({
      name: 'FeedError',
      kind: 'http',
    });
  });

  it('maps invalid JSON to a parse FeedError', async () => {
    await expect(fetchSnapshot(`${origin}/bad-json`)).rejects.toMatchObject({
      name: 'FeedError',
      kind: 'parse',
    });
  });

  it('exposes the documented default feed url', () => {
    expect(FEED_URL).toContain('bounds=14.0,4.0,2.5,15.0');
    expect(FEED_URL).toContain('maxage=14400');
    expect(FEED_URL).toContain('stats=1');
  });
});
