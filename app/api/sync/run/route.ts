import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { enqueueSourceSync, type SyncMode } from "@/worker/sourcesSync.queue";
import { enabledSources, getSource } from "@/lib/sync/sources";

export const dynamic = "force-dynamic";

/**
 * Disparo manual de la sincronización (panel admin).
 *
 *   POST /api/sync/run?dryRun=1            -> simula, no escribe
 *   POST /api/sync/run?source=<id>         -> solo esa fuente
 *   POST /api/sync/run?limit=50            -> tope de registros por fuente
 *   POST /api/sync/run?mode=chunk          -> por chunks (cursor en sync_state)
 *   POST /api/sync/run?mode=chunk&pages=20 -> tope de páginas por corrida
 *
 * Autenticación: header `x-admin-token` (ver lib/admin.ts).
 */
/**
 * @swagger
 * /api/sync/run:
 *   post:
 *     tags: [sync]
 *     summary: Dispara manualmente la sincronización de fuentes externas (requiere x-admin-token)
 *     parameters:
 *       - in: query
 *         name: dryRun
 *         required: false
 *         schema: { type: string, enum: ['1', 'true'] }
 *         description: Si es 1/true simula la corrida sin escribir.
 *       - in: query
 *         name: source
 *         required: false
 *         schema: { type: string }
 *         description: Limita la corrida a una sola fuente por su id.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1 }
 *         description: Tope de registros por fuente.
 *       - in: query
 *         name: mode
 *         required: false
 *         schema: { type: string, enum: [chunk] }
 *         description: Si es chunk procesa por páginas usando el cursor en sync_state.
 *       - in: query
 *         name: pages
 *         required: false
 *         schema: { type: integer, minimum: 1 }
 *         description: Tope de páginas por corrida (solo con mode=chunk).
 *     responses:
 *       202:
 *         description: >-
 *           Corrida ENCOLADA. El sync ya no corre inline (audit M-2): se procesa
 *           en el worker. Consulta el estado con GET /api/sync/status?jobId=.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 queued: { type: boolean }
 *                 jobIds:
 *                   type: array
 *                   items: { type: string }
 *       400:
 *         description: Fuente desconocida.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: No autorizado (falta o es inválido x-admin-token).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: No se pudo encolar (cola no disponible).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
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
  // mode=chunk → procesa por páginas con cursor; si no, corrida completa.
  const mode: SyncMode = params.get("mode") === "chunk" ? "chunk" : "full";
  const pagesParam = Number(params.get("pages"));
  const pagesPerRun =
    Number.isFinite(pagesParam) && pagesParam > 0 ? pagesParam : undefined;

  // Validar la fuente (si se pidió una) antes de encolar.
  if (source && !getSource(source)) {
    return NextResponse.json(
      { error: `Fuente desconocida: ${source}` },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const sources = source ? [getSource(source)!] : enabledSources();

  try {
    // Encolar un job por fuente y devolver de inmediato (patrón 202, audit M-2).
    const jobIds = await Promise.all(
      sources.map((s) =>
        enqueueSourceSync({ sourceId: s.id, mode, dryRun, limit, pagesPerRun }),
      ),
    );
    return NextResponse.json(
      { ok: true, queued: true, jobIds },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "No se pudo encolar." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
