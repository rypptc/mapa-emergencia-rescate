import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { runAllSources } from "@/lib/sync/engine";

export const dynamic = "force-dynamic";
// Traer fuentes grandes + upsert puede tardar; ampliamos el límite de función.
export const maxDuration = 300;

/**
 * Disparo manual de la sincronización (panel admin).
 *
 *   POST /api/sync/run?dryRun=1            -> simula, no escribe
 *   POST /api/sync/run?source=<id>         -> solo esa fuente
 *   POST /api/sync/run?limit=50            -> tope de registros por fuente
 *
 * Autenticación: header `x-admin-token` (ver lib/admin.ts).
 */
export async function POST(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { error: "No autorizado." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const params = new URL(request.url).searchParams;
  const dryRun = params.get("dryRun") === "1" || params.get("dryRun") === "true";
  const source = params.get("source");
  const limitParam = Number(params.get("limit"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  try {
    const results = await runAllSources({
      dryRun,
      limit,
      sourceIds: source ? [source] : undefined,
    });

    const totals = results.reduce(
      (acc, r) => ({
        fetched: acc.fetched + r.fetched,
        inserted: acc.inserted + r.inserted,
        updated: acc.updated + r.updated,
        skipped: acc.skipped + r.skipped,
        errors: acc.errors + r.errors,
      }),
      { fetched: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 },
    );

    return NextResponse.json(
      { ok: results.every((r) => r.ok), dryRun, totals, results },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error al sincronizar." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
