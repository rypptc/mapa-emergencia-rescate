import { NextResponse } from "next/server";
import { isCronRequest } from "@/lib/admin";
import { enqueueGeocode } from "@/worker/maintenance.queue";

export const dynamic = "force-dynamic";

/**
 * Trigger del geocode. YA NO corre Nominatim inline (audit M-2): solo ENCOLA y
 * vuelve 202. En Hetzner el camino primario es el scheduler del worker
 * (registerMaintenanceSchedulers, cada 5 min); este endpoint queda como trigger
 * externo/manual. Idempotente (jobId fijo). Sin frontend: nadie espera el
 * resultado (alimenta geocode_cache → el mapa).
 *
 *   GET /api/sync/geocode            -> lote por defecto
 *   GET /api/sync/geocode?max=30     -> tope de ubicaciones únicas
 *
 * Auth: `Authorization: Bearer $CRON_SECRET` o token admin.
 */
/**
 * @swagger
 * /api/sync/geocode:
 *   get:
 *     tags: [sync]
 *     summary: Geocodifica un lote de ubicaciones sin coordenadas (cron, requiere auth Bearer CRON_SECRET o token admin)
 *     parameters:
 *       - in: query
 *         name: max
 *         required: false
 *         description: Tope de ubicaciones únicas a geocodificar en la corrida.
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       202:
 *         description: Geocode encolado. Estado vía GET /api/sync/status?jobId=.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *                 queued: { type: boolean }
 *                 jobId: { type: string }
 *       401:
 *         description: No autorizado.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: No se pudo encolar.
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

  const maxParam = Number(new URL(request.url).searchParams.get("max"));
  const maxLocations =
    Number.isFinite(maxParam) && maxParam > 0 ? maxParam : undefined;

  try {
    const jobId = await enqueueGeocode(maxLocations);
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
