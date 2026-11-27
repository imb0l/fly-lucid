import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { describeError, getJson, type Aircraft, type Health } from '../api';
import { fmtWatClock } from '../format';

const DEFAULT_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const envStyleUrl = import.meta.env.VITE_MAP_STYLE_URL as string | undefined;
const STYLE_URL = envStyleUrl && envStyleUrl.trim() ? envStyleUrl.trim() : DEFAULT_STYLE_URL;

const AIRBORNE_COLOR = '#1f6feb';
const GROUND_COLOR = '#8a939e';
const SOURCE_ID = 'aircraft-live';
const POLL_MS = 30_000;
const NIGERIA_BOUNDS: [number, number, number, number] = [2.5, 4.0, 15.0, 14.0];

function plainStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'plain-background', type: 'background', paint: { 'background-color': '#eef1f5' } }],
  };
}

function isStyleSpec(value: unknown): value is StyleSpecification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.version === 8 && Array.isArray(v.layers);
}

async function loadBasemapStyle(url: string, signal: AbortSignal): Promise<StyleSpecification | null> {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal.addEventListener('abort', abort);
  const timer = window.setTimeout(abort, 8000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    return isStyleSpec(json) ? json : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

interface AircraftFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    hex: string;
    flt: string;
    reg: string;
    type: string;
    altFt: number;
    gsKt: number;
    hdg: number;
    onGround: boolean;
    orig: string;
    dest: string;
  };
}

type SourceData = Parameters<GeoJSONSource['setData']>[0];

function toCollection(aircraft: Aircraft[]): SourceData {
  const features: AircraftFeature[] = [];
  for (const a of aircraft) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
      properties: {
        hex: a.hex,
        flt: a.flt ?? '',
        reg: a.reg ?? '',
        type: a.type ?? '',
        altFt: a.altFt ?? 0,
        gsKt: a.gsKt ?? 0,
        hdg: typeof a.hdg === 'number' && Number.isFinite(a.hdg) ? a.hdg : 0,
        onGround: Boolean(a.onGround),
        orig: a.orig ?? '',
        dest: a.dest ?? '',
      },
    });
  }
  return { type: 'FeatureCollection', features } as unknown as SourceData;
}

/** North-pointing arrow; MapLibre rotates icons clockwise by `icon-rotate`. */
function planeIcon(color: string): ImageData | null {
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.translate(size / 2, size / 2);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -19);
  ctx.lineTo(9, 12);
  ctx.lineTo(0, 6);
  ctx.lineTo(-9, 12);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  return ctx.getImageData(0, 0, size, size);
}

const ICON_AIRBORNE = 'plane-airborne';
const ICON_GROUND = 'plane-ground';

function installAircraftLayers(map: maplibregl.Map): void {
  if (!map.getSource(SOURCE_ID)) {
    map.addSource(SOURCE_ID, { type: 'geojson', data: toCollection([]) });
  }
  if (!map.hasImage(ICON_AIRBORNE)) {
    const image = planeIcon(AIRBORNE_COLOR);
    if (image) map.addImage(ICON_AIRBORNE, image);
  }
  if (!map.hasImage(ICON_GROUND)) {
    const image = planeIcon(GROUND_COLOR);
    if (image) map.addImage(ICON_GROUND, image);
  }
  if (!map.getLayer('aircraft-dot')) {
    map.addLayer({
      id: 'aircraft-dot',
      type: 'circle',
      source: SOURCE_ID,
      paint: {
        'circle-color': ['case', ['get', 'onGround'], GROUND_COLOR, AIRBORNE_COLOR],
        'circle-radius': ['case', ['get', 'onGround'], 3, 4],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1,
      },
    });
  }
  if (!map.getLayer('aircraft-arrow')) {
    map.addLayer({
      id: 'aircraft-arrow',
      type: 'symbol',
      source: SOURCE_ID,
      layout: {
        'icon-image': ['case', ['get', 'onGround'], ICON_GROUND, ICON_AIRBORNE],
        'icon-size': ['case', ['get', 'onGround'], 0.32, 0.42],
        'icon-rotate': ['get', 'hdg'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    });
  }
}

function pushAircraft(map: maplibregl.Map, aircraft: Aircraft[]): void {
  const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
  if (source) source.setData(toCollection(aircraft));
}

type BasemapState = 'loading' | 'ready' | 'plain';

export default function LiveMapPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const aircraftRef = useRef<Aircraft[]>([]);
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapState>('loading');
  const [mapError, setMapError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let mapLoaded = false;
    let pendingStyle: StyleSpecification | null = null;
    let basemapApplied = false;
    let basemapStyleLoaded = false;
    let guardTimer: number | null = null;

    const clearGuard = (): void => {
      if (guardTimer !== null) {
        window.clearTimeout(guardTimer);
        guardTimer = null;
      }
    };

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: plainStyle(),
        bounds: NIGERIA_BOUNDS,
        fitBoundsOptions: { padding: 32 },
        attributionControl: false,
        maxZoom: 12,
      });
    } catch (err) {
      // A missing WebGL context throws here; keep the page usable without a map.
      setMapError(describeError(err));
      setBasemap('plain');
      return;
    }
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    // Tile, sprite and glyph failures must not break the page: the plain style stays usable.
    map.on('error', () => undefined);

    const applyPendingStyle = (): void => {
      if (!pendingStyle || !mapLoaded || cancelled) return;
      const style = pendingStyle;
      pendingStyle = null;
      basemapApplied = true;
      try {
        map.setStyle(style, { diff: false });
      } catch {
        setBasemap('plain');
        return;
      }
      // If the fetched style never finishes loading, drop back to the plain background.
      guardTimer = window.setTimeout(() => {
        guardTimer = null;
        if (cancelled || basemapStyleLoaded) return;
        try {
          map.setStyle(plainStyle(), { diff: false });
        } catch {
          /* the map is gone or mid-removal */
        }
        setBasemap('plain');
      }, 10_000);
    };

    map.on('load', () => {
      mapLoaded = true;
      applyPendingStyle();
    });
    map.on('style.load', () => {
      if (basemapApplied) basemapStyleLoaded = true;
      clearGuard();
      installAircraftLayers(map);
      pushAircraft(map, aircraftRef.current);
    });

    const controller = new AbortController();
    void loadBasemapStyle(STYLE_URL, controller.signal).then((style) => {
      if (cancelled) return;
      if (!style) {
        setBasemap('plain');
        return;
      }
      pendingStyle = style;
      setBasemap('ready');
      applyPendingStyle();
    });

    return () => {
      cancelled = true;
      controller.abort();
      clearGuard();
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        const live = await getJson<Aircraft[]>('/api/live', controller.signal);
        if (cancelled) return;
        const list = Array.isArray(live) ? live : [];
        aircraftRef.current = list;
        setAircraft(list);
        setLiveError(null);
        if (mapRef.current) pushAircraft(mapRef.current, list);
      } catch (err) {
        if (cancelled) return;
        setLiveError(describeError(err));
      }
      try {
        const nextHealth = await getJson<Health>('/api/health', controller.signal);
        if (!cancelled) setHealth(nextHealth);
      } catch {
        /* health is advisory: the map itself still renders */
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  const asOf = useMemo(() => {
    let newest = 0;
    for (const a of aircraft) {
      if (typeof a.ts === 'number' && a.ts > newest) newest = a.ts;
    }
    if (!newest && health?.lastPollOkTs && health.lastPollOkTs > 0) newest = health.lastPollOkTs;
    return newest || null;
  }, [aircraft, health]);

  const airborneCount = useMemo(() => aircraft.filter((a) => !a.onGround).length, [aircraft]);
  const hasFreshPositions = aircraft.length > 0 && !liveError;
  const lastUpdateText = asOf ? `${fmtWatClock(asOf)} WAT` : 'unavailable';
  const freshnessLine = hasFreshPositions
    ? `${airborneCount} airborne · ${aircraft.length - airborneCount} on the ground · refreshed every 30 seconds`
    : liveError
      ? `No fresh positions — the live feed did not respond; last update ${lastUpdateText}.`
      : `No fresh positions — the live feed returned no aircraft; last update ${lastUpdateText}.`;

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Live aircraft over Nigeria</h1>
          <p className="muted" role="status">
            {freshnessLine}
          </p>
        </div>
        <div className="map-stats" role="status" aria-live="polite">
          <div className="stat">
            <span className="stat-value">{hasFreshPositions ? aircraft.length : '—'}</span>
            <span className="stat-label">aircraft</span>
          </div>
          <div className="stat stat-time">
            {hasFreshPositions ? `as of ${lastUpdateText}` : `last update ${lastUpdateText}`}
          </div>
        </div>
      </div>

      {health?.feedStale && (
        <p className="banner banner-warn" role="alert">
          Live feed is stale — no successful update in the last three minutes, so positions may be out of date.
        </p>
      )}
      {liveError && (
        <p className="banner banner-error" role="alert">
          {liveError}
        </p>
      )}

      <div className="map-shell" role="region" aria-label="Live aircraft map over Nigeria">
        {mapError ? (
          <div
            className="map"
            role="alert"
            style={{ display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}
          >
            <div>
              <p>
                <strong>Map unavailable</strong>
              </p>
              <p className="muted">
                {hasFreshPositions
                  ? `${aircraft.length} aircraft in the latest feed · ${airborneCount} airborne · ${aircraft.length - airborneCount} on the ground`
                  : `No fresh positions — last update ${lastUpdateText}.`}
              </p>
              <p className="hint">{mapError}</p>
            </div>
          </div>
        ) : (
          <div ref={containerRef} className="map" />
        )}
        {basemap === 'loading' && !mapError && (
          <div className="map-loading" role="status" aria-live="polite">
            Loading map…
          </div>
        )}
        <div className="map-legend">
          <span>
            <i className="dot dot-air" /> Airborne
          </span>
          <span>
            <i className="dot dot-ground" /> On ground
          </span>
        </div>
      </div>

      {basemap === 'plain' && !mapError && (
        <p className="hint">Basemap could not be loaded — aircraft are plotted on a plain background.</p>
      )}
    </section>
  );
}
