import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { enqueueDuplicatesReport } from "@/worker/maintenance.queue";

export const dynamic = "force-dynamic";

/**
 * Reporte de posibles duplicados (read-only). El cálculo (CTE pesado, ~60s) ya no
 * corre inline (audit M-2): se ENCOLA y el admin lee el resultado con status-poll
 * (GET /api/sync/status?jobId=). Solo detecta/reporta; no modifica nada.
 *
 *   POST /api/sync/duplicates?source=<id>&limit=<n>  -> { jobId }
 *
 * Auth: header `x-admin-token`.
 */
/**
 * @swagger
 * /api/sync/duplicates:
 *   post:
 *     tags: [sync]
 *     summary: Encola el reporte de posibles duplicados (requiere x-admin-token)
 *     parameters:
 *       - in: query
 *         name: source
 *         required: false
 *         schema: { type: string }
 *         description: Filtra el reporte por id de fuente externa.
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer }
 *         description: Máximo de grupos de duplicados a devolver.
 *     responses:
 *       202:
 *         description: Reporte encolado. Lee el resultado con GET /api/sync/status?jobId=.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 queued: { type: boolean }
 *                 jobId: { type: string }
 *       401:
 *         description: No autorizado (falta o es inválido x-admin-token).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: No se pudo encolar.
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
  const source = params.get("source") ?? undefined;
  const limitParam = Number(params.get("limit"));
  const limitGroups =
    Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;

  try {
    const jobId = await enqueueDuplicatesReport(source, limitGroups);
    return NextResponse.json(
      { ok: true, queued: true, jobId },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "No se pudo encolar." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
