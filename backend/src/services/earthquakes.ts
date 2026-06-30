/**
 * Service de sismos (USGS). La LÓGICA y las consultas Drizzle viven aquí; el
 * route solo hace HTTP, y el worker llama a `syncFromFeed()` / `backfill()`.
 *
 * Dos fuentes USGS (https://earthquake.usgs.gov), ambas GeoJSON, sin auth:
 *  - **Feed realtime** (`/earthquakes/feed/v1.0/summary/<mag>_<window>.geojson`):
 *    CDN-cacheado, se refresca cada minuto. Es GLOBAL → filtramos al bounding box
 *    de Venezuela en código. Lo recomienda el propio USGS para apps automáticas.
 *  - **FDSN query** (`/fdsnws/event/1/query`): acepta bbox server-side + ventana
 *    de tiempo. Lo usamos SOLO para el backfill puntual.
 *
 * Idempotencia: hacemos upsert por `id` (el id de evento del USGS). USGS revisa
 * la magnitud horas después del sismo (campo `updated`), así que en conflicto
 * sobreescribimos. Venezuela genera <1 sismo/día → el catálogo es pequeño.
 *
 * Sin dependencias nuevas: `fetch` nativo (Node 20+) y Drizzle.
 */
import { desc, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

const { earthquakes } = schema;

// Bounding box de Venezuela (lat 0.6–12.2, lon -73.4 a -59.8). Tunable por env
// si alguna vez se quiere ampliar la cobertura (p. ej. zona fronteriza).
export const VENEZUELA_BBOX = {
  minLat: Number(process.env.EARTHQUAKES_MIN_LAT || 0.6),
  maxLat: Number(process.env.EARTHQUAKES_MAX_LAT || 12.2),
  minLng: Number(process.env.EARTHQUAKES_MIN_LNG || -73.4),
  maxLng: Number(process.env.EARTHQUAKES_MAX_LNG || -59.8),
};

const USGS_BASE = "https://earthquake.usgs.gov";
// Feed realtime que poleamos: M2.5+ de los últimos 7 días (suficiente solapamiento
// para no perder eventos entre corridas; el upsert deduplica). USGS no cataloga
// bajo ~2.5 en esta región, así que "2.5" ≈ "todo lo cataloga".
const FEED_PATH =
  process.env.EARTHQUAKES_FEED_PATH ||
  "/earthquakes/feed/v1.0/summary/2.5_week.geojson";

const FETCH_TIMEOUT_MS = Number(process.env.EARTHQUAKES_FETCH_TIMEOUT_MS || 15_000);

// --------------------------------------------------------------------------
// Tipos GeoJSON del USGS (solo los campos que consumimos).
// --------------------------------------------------------------------------
interface UsgsFeature {
  id: string;
  properties: {
    mag: number | null;
    place: string | null;
    time: number | null; // epoch-ms
    updated: number | null; // epoch-ms
    alert: string | null;
    tsunami: number | null; // 0 | 1
    sig: number | null;
  };
  geometry: { coordinates: [number, number, number] } | null; // [lon, lat, depthKm]
}
interface UsgsFeatureCollection {
  features: UsgsFeature[];
}

/** Fila lista para upsert (espeja columnas de la tabla earthquakes). */
type EarthquakeRow = typeof earthquakes.$inferInsert;

// --------------------------------------------------------------------------
// Fetch + parse
// --------------------------------------------------------------------------

async function fetchJson(url: string): Promise<UsgsFeatureCollection> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/geo+json,application/json" },
    });
    if (!res.ok) {
      throw new Error(`USGS ${res.status} ${res.statusText} for ${url}`);
    }
    return (await res.json()) as UsgsFeatureCollection;
  } finally {
    clearTimeout(t);
  }
}

function inVenezuela(lat: number, lng: number): boolean {
  return (
    lat >= VENEZUELA_BBOX.minLat &&
    lat <= VENEZUELA_BBOX.maxLat &&
    lng >= VENEZUELA_BBOX.minLng &&
    lng <= VENEZUELA_BBOX.maxLng
  );
}

/** Convierte un feature USGS en fila, o null si no es válido / fuera de bbox. */
function toRow(f: UsgsFeature, fetchedAt: number): EarthquakeRow | null {
  const c = f.geometry?.coordinates;
  if (!f.id || !c || c.length < 2) return null;
  const [lng, lat, depthKm] = c;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (!inVenezuela(lat, lng)) return null;
  const p = f.properties;
  const occurredAt = p.time;
  if (!Number.isFinite(occurredAt as number)) return null;

  return {
    id: f.id,
    magnitude: p.mag ?? null,
    place: p.place ?? "Ubicación desconocida",
    lat,
    lng,
    depthKm: Number.isFinite(depthKm) ? depthKm : null,
    alert: p.alert ?? null,
    tsunami: p.tsunami === 1,
    sig: p.sig ?? null,
    usgsUpdatedAt: (p.updated ?? occurredAt) as number,
    occurredAt: occurredAt as number,
    fetchedAt,
  };
}

// --------------------------------------------------------------------------
// Upsert
// --------------------------------------------------------------------------

/**
 * Upsert por `id` (PK = id de evento USGS). En conflicto sobreescribe los campos
 * que el USGS revisa (magnitud, alert, sig, etc.) y `fetchedAt`. Devuelve cuántas
 * filas se procesaron.
 */
async function upsertRows(rows: EarthquakeRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  await getDb()
    .insert(earthquakes)
    .values(rows)
    .onConflictDoUpdate({
      target: earthquakes.id,
      set: {
        magnitude: sql`excluded.magnitude`,
        place: sql`excluded.place`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        depthKm: sql`excluded.depth_km`,
        alert: sql`excluded.alert`,
        tsunami: sql`excluded.tsunami`,
        sig: sql`excluded.sig`,
        usgsUpdatedAt: sql`excluded.usgs_updated_at`,
        occurredAt: sql`excluded.occurred_at`,
        fetchedAt: sql`excluded.fetched_at`,
      },
    });
  return rows.length;
}

export interface SyncResult {
  source: "feed" | "backfill";
  fetched: number; // features traídos del USGS
  matched: number; // dentro del bbox de Venezuela
  upserted: number;
}

/**
 * Sync incremental: poleado del feed realtime global → filtra a Venezuela →
 * upsert. Lo llama el scheduler del worker cada minuto.
 */
export async function syncFromFeed(now: number): Promise<SyncResult> {
  const fc = await fetchJson(`${USGS_BASE}${FEED_PATH}`);
  const features = fc.features ?? [];
  const rows = features
    .map((f) => toRow(f, now))
    .filter((r): r is EarthquakeRow => r !== null);
  const upserted = await upsertRows(rows);
  return { source: "feed", fetched: features.length, matched: rows.length, upserted };
}

/**
 * Backfill puntual: FDSN query con bbox server-side + ventana de tiempo. Por
 * defecto los últimos 30 días. Una sola llamada (el catálogo de Venezuela es
 * chico). Idempotente: re-correrlo solo refresca.
 */
export async function backfill(now: number, days?: number): Promise<SyncResult> {
  const windowDays = days ?? Number(process.env.EARTHQUAKES_BACKFILL_DAYS || 30);
  const start = new Date(now - windowDays * 24 * 60 * 60_000).toISOString();
  const params = new URLSearchParams({
    format: "geojson",
    starttime: start,
    minlatitude: String(VENEZUELA_BBOX.minLat),
    maxlatitude: String(VENEZUELA_BBOX.maxLat),
    minlongitude: String(VENEZUELA_BBOX.minLng),
    maxlongitude: String(VENEZUELA_BBOX.maxLng),
    orderby: "time",
  });
  const fc = await fetchJson(`${USGS_BASE}/fdsnws/event/1/query?${params}`);
  const features = fc.features ?? [];
  // El bbox ya filtra server-side, pero re-validamos por seguridad.
  const rows = features
    .map((f) => toRow(f, now))
    .filter((r): r is EarthquakeRow => r !== null);
  const upserted = await upsertRows(rows);
  return { source: "backfill", fetched: features.length, matched: rows.length, upserted };
}

/** True si la tabla no tiene filas (para decidir backfill en el arranque). */
export async function isEmpty(): Promise<boolean> {
  const rows = await getDb()
    .select({ n: sql<number>`count(*)::int` })
    .from(earthquakes);
  return (rows[0]?.n ?? 0) === 0;
}

// --------------------------------------------------------------------------
// Lectura (DTO público — allowlist, nunca fila cruda)
// --------------------------------------------------------------------------

export interface EarthquakeDTO {
  id: string;
  magnitude: number | null;
  place: string;
  lat: number;
  lng: number;
  depthKm: number | null;
  alert: string | null;
  tsunami: boolean;
  sig: number | null;
  occurredAt: number; // epoch-ms
}

/** Lista los sismos más recientes (orden: más nuevo primero). */
export async function listEarthquakes(limit = 100): Promise<EarthquakeDTO[]> {
  const rows = await getDb()
    .select()
    .from(earthquakes)
    .orderBy(desc(earthquakes.occurredAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    magnitude: r.magnitude,
    place: r.place,
    lat: r.lat,
    lng: r.lng,
    depthKm: r.depthKm,
    alert: r.alert,
    tsunami: r.tsunami,
    sig: r.sig,
    occurredAt: r.occurredAt,
  }));
}
