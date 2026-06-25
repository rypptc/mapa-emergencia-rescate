/**
 * Motor de sincronización: corre un adaptador, normaliza y hace upsert por el
 * camino único (`upsertExternalMissing`). Acumula contadores y nunca deja que
 * el fallo de una fuente tumbe a las demás.
 *
 * Ver docs/rfcs/0001-sincronizacion-fuentes.md
 */

import { hasDbEnv } from "../db";
import { upsertExternalMissing } from "../missing";
import type { SourceAdapter, SyncResult } from "./types";
import { enabledSources, getSource } from "./sources";

const DEFAULT_USER_AGENT =
  "MapaEmergenciaVE/1.0 (+https://terremotovenezuela.app)";

export interface RunOptions {
  dryRun?: boolean;
  /** Tope de registros a procesar por fuente. */
  limit?: number;
}

function userAgent(): string {
  return process.env.SYNC_USER_AGENT || DEFAULT_USER_AGENT;
}

/** Sincroniza una sola fuente. Nunca lanza: empaqueta el fallo en el resultado. */
export async function runSync(
  adapter: SourceAdapter,
  opts: RunOptions = {},
): Promise<SyncResult> {
  const dryRun = Boolean(opts.dryRun);
  const startedAt = Date.now();
  const base: SyncResult = {
    source: adapter.id,
    ok: false,
    dryRun,
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    startedAt,
    finishedAt: startedAt,
    durationMs: 0,
  };

  if (!dryRun && !hasDbEnv()) {
    return finalize({
      ...base,
      error: "DATABASE_URL no configurada: la sincronización necesita DB.",
    });
  }

  try {
    const people = await adapter.fetchAll({
      userAgent: userAgent(),
      limit: opts.limit,
    });
    base.fetched = people.length;

    for (const person of people) {
      if (!person.name?.trim() || !person.externalId?.trim()) {
        base.skipped++;
        continue;
      }
      if (dryRun) {
        base.inserted++; // en dry-run contamos como "se procesaría"
        continue;
      }
      try {
        const { inserted } = await upsertExternalMissing(person);
        if (inserted) base.inserted++;
        else base.updated++;
      } catch {
        base.errors++;
      }
    }

    return finalize({ ...base, ok: true });
  } catch (err) {
    return finalize({
      ...base,
      error: err instanceof Error ? err.message : "Error desconocido.",
    });
  }
}

/** Sincroniza todas las fuentes habilitadas (o las indicadas en `sourceIds`). */
export async function runAllSources(
  opts: RunOptions & { sourceIds?: string[] } = {},
): Promise<SyncResult[]> {
  const adapters = opts.sourceIds?.length
    ? opts.sourceIds
        .map((id) => getSource(id))
        .filter((a): a is SourceAdapter => Boolean(a))
    : enabledSources();

  const results: SyncResult[] = [];
  for (const adapter of adapters) {
    results.push(await runSync(adapter, opts));
  }
  return results;
}

function finalize(r: SyncResult): SyncResult {
  const finishedAt = Date.now();
  return { ...r, finishedAt, durationMs: finishedAt - r.startedAt };
}
