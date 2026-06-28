import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getSyncJobState } from "@/worker/sourcesSync.queue";
import { getMaintenanceJobState } from "@/worker/maintenance.queue";

export const dynamic = "force-dynamic";

/**
 * @swagger
 * /api/sync/status:
 *   get:
 *     tags: [sync]
 *     summary: Estado de un job de sync encolado (status-poll, requiere x-admin-token)
 *     parameters:
 *       - in: query
 *         name: jobId
 *         required: true
 *         schema: { type: string }
 *         description: jobId devuelto por POST /api/sync/run (o el cron).
 *     responses:
 *       200:
 *         description: Estado + resultado del job.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string }
 *                 state: { type: string, description: 'waiting|active|completed|failed|delayed' }
 *                 progress: {}
 *                 result: {}
 *                 failedReason: { type: string, nullable: true }
 *       400:
 *         description: Falta jobId.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: No autorizado.
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Job no encontrado (expiró o id inválido).
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(request: Request) {
  if (!isAdminRequest(request)) {
    return NextResponse.json(
      { error: "No autorizado." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json(
      { error: "Falta el parámetro jobId." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  // El jobId trae prefijo de su cola (sync-* / maint-*); consultamos la que
  // corresponde, con la otra como respaldo.
  const state = jobId.startsWith("maint-")
    ? (await getMaintenanceJobState(jobId)) ?? (await getSyncJobState(jobId))
    : (await getSyncJobState(jobId)) ?? (await getMaintenanceJobState(jobId));
  if (!state) {
    return NextResponse.json(
      { error: "Job no encontrado." },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(state, { headers: { "Cache-Control": "no-store" } });
}
