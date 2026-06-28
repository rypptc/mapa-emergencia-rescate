import { NextResponse } from "next/server";
import { BODY_LIMIT_TEXT, bodyErrorResponse, readJson } from "@/lib/body";
import { cached, invalidate } from "@/lib/cache";
import { jsonWithEtag } from "@/lib/http";
import { getHospital } from "@/lib/hospitals";
import {
  getPublicHospitalSupplySummary,
  upsertHospitalSupplyStatus,
  type SupplyStatusUpdateInput,
} from "@/lib/hospital-supplies";
import { isHospitalSupplyWriteRequest } from "@/lib/supply-auth";

export const dynamic = "force-dynamic";

const PUBLIC_CACHE_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=10, stale-while-revalidate=60",
};

/**
 * @swagger
 * /api/hospitals/{id}/supplies:
 *   get:
 *     tags: [hospitals]
 *     summary: Lee el estado público seguro de insumos de un hospital
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Id o slug del hospital.
 *     responses:
 *       200:
 *         description: Estado de insumos público, sin contacto POC ni notas restringidas
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hospital: { $ref: '#/components/schemas/Hospital' }
 *                 supply: { $ref: '#/components/schemas/HospitalSupplySummary' }
 *       404:
 *         description: Hospital no encontrado
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *   post:
 *     tags: [hospitals]
 *     summary: Actualiza o confirma el semáforo de una categoría de insumos (requiere x-admin-token o x-hospital-poc-token del hospital)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { $ref: '#/components/schemas/HospitalSupplyStatusUpdateInput' }
 *     responses:
 *       200:
 *         description: Categoría actualizada o confirmada sin cambios
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { $ref: '#/components/schemas/HospitalSupplyStatus' }
 *                 supply: { $ref: '#/components/schemas/HospitalSupplySummary' }
 *       400:
 *         description: Datos inválidos
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       413:
 *         description: Payload demasiado grande
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       401:
 *         description: No autorizado (falta token admin o POC activo para el hospital)
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       404:
 *         description: Hospital no encontrado
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 *       503:
 *         description: No se pudo guardar el estado
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Error' }
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hospital = await getHospital(id);
  if (!hospital) {
    return NextResponse.json(
      { error: "Hospital no encontrado." },
      { status: 404, headers: PUBLIC_CACHE_HEADERS },
    );
  }
  // GET público polleado: cache en proceso por ventana + jsonWithEtag (304) como
  // reports/missing/chat — el CDN absorbe el edge, esto evita pegar a la DB en
  // cada miss de origen y corto-circuita con 304 cuando no cambió nada.
  const supply = await cached(`hsupply:${hospital.id}`, 10_000, () =>
    getPublicHospitalSupplySummary(hospital.id),
  );
  return jsonWithEtag(request, { hospital, supply }, PUBLIC_CACHE_HEADERS);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const hospital = await getHospital(id);
  if (!hospital) {
    return NextResponse.json({ error: "Hospital no encontrado." }, { status: 404 });
  }
  if (!(await isHospitalSupplyWriteRequest(request, hospital.id))) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }

  let body: SupplyStatusUpdateInput;
  try {
    body = await readJson(request, BODY_LIMIT_TEXT);
  } catch (e) {
    return bodyErrorResponse(e);
  }

  try {
    const result = await upsertHospitalSupplyStatus(hospital.id, body);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }
    invalidate();
    const supply = await getPublicHospitalSupplySummary(hospital.id);
    return NextResponse.json({ status: result.value, supply });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Error desconocido";
    return NextResponse.json(
      { error: `No se pudo guardar el estado de insumos: ${message}` },
      { status: 503 },
    );
  }
}
