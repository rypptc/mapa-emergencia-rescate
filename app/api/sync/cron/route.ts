import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/admin";
import { enqueueSourceSync } from "@/worker/sourcesSync.queue";
import { enabledSources } from "@/lib/sync/sources";

export const dynamic = "force-dynamic";

/**
 * Trigger externo del sync (cron de Vercel / cualquier scheduler externo). YA NO
 * corre el sync inline (audit M-2): solo ENCOLA un job chunked por fuente y vuelve
 * 202. En Hetzner el camino primario es el scheduler del worker
 * (registerSourceSchedulers); este endpoint queda como trigger manual/externo y
 * fallback. Idempotente (jobId determinístico por fuente+modo).
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` o token admin.
 */
/**
 * @swagger
 * /api/sync/cron:
 *   get:
 *     tags: [sync]
 *     summary: Dispara el cron de sincronización de fuentes externas (Auth Bearer CRON_SECRET o admin)
 *     responses:
 *       202:
 *         description: Sync encolado (un job chunked por fuente). Estado vía /api/sync/status.
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
 *       401:
 *         description: No autorizado
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: No se pudo encolar
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) {
    return NextResponse.json(
      { error: "No autorizado." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const jobIds = await Promise.all(
      enabledSources().map((s) =>
        enqueueSourceSync({ sourceId: s.id, mode: "chunk" }),
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
