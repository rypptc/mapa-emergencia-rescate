/**
 * Postgres pools for the migration workers.
 *  - target: the Hetzner `app` DB (DATABASE_URL) — where everything lands.
 *  - source: the Neon prod DB (NEON_DATABASE_URL) — only needed by the
 *    table-migration job; image jobs operate purely on the target.
 *
 * Both are plain TCP Postgres, so we use node-postgres (pg) for both — same
 * BIGINT-as-number parsing as lib/db.ts so epoch-ms values stay numeric.
 */
import { Pool, types } from "pg";

// BIGINT (oid 20) -> JS number (epoch-ms are within Number.MAX_SAFE_INTEGER).
types.setTypeParser(20, (v: string) => parseInt(v, 10));

let _target: Pool | null = null;
let _source: Pool | null = null;

export function targetPool(): Pool {
  if (_target) return _target;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (target / Hetzner app DB) not set");
  // max ≥ suma de concurrencias de los workers que pegan al target (audit M-4).
  // Ya no se retiene conexión a través de I/O de red (ver migratePhoto), pero
  // varias colas concurrentes igual necesitan holgura. Tunable por env.
  const max = Number(process.env.TARGET_POOL_MAX || 16);
  _target = new Pool({ connectionString: url, max });
  return _target;
}

export function sourcePool(): Pool {
  if (_source) return _source;
  const url = process.env.NEON_DATABASE_URL;
  if (!url) throw new Error("NEON_DATABASE_URL (source / Neon) not set");
  // Neon requires SSL; the URL already carries sslmode=require.
  _source = new Pool({ connectionString: url, max: 4 });
  return _source;
}

export async function closePools(): Promise<void> {
  await Promise.allSettled([_target?.end(), _source?.end()]);
  _target = null;
  _source = null;
}
