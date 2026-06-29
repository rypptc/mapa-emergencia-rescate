/**
 * Superficie autenticada `api/public/patient-imports` (#151) — importación de
 * pacientes hospitalarios para integraciones/admin.
 *
 * NO es un CRUD de modelo, así que va escrito a mano (no por la fábrica) pero
 * respeta las MISMAS reglas de `api/public/*`: deny-by-default con
 * requireCapability("patient:import") en CADA ruta, rateLimit en cada ruta, sin
 * Turnstile (no es navegador), validación zod y auditoría de las mutaciones.
 *
 * El trabajo pesado (normalizar/validar/deduplicar/aplicar) NO corre inline: se
 * encola en BullMQ y el endpoint responde 202 con el id consultable. Las filas
 * de staging guardan el dato crudo + el resultado de validación/dedup ANTES de
 * escribir cualquier paciente final; el apply es idempotente y omite las filas
 * inválidas/duplicadas/en revisión.
 *
 * Privacidad: las respuestas son allowlists. NUNCA exponen el dato crudo, el
 * documento/cédula, las notas, el contacto ni los hashes — solo estado,
 * contadores y errores/avisos de revisión.
 */
import { Router, json } from "express";
import { z } from "zod";
import { asyncHandler, rateLimit, validate } from "@/middleware";
import { requireCapability } from "@/middleware/auth";
import { notFound, badRequest, serviceUnavailable } from "@/lib/errors";
import { writeAudit } from "@/auth/audit";
import { enqueuePatientImport } from "@/lib/queues";
import * as service from "@/services/patient-imports";

export const patientImportsRouter = Router();

// D2: el parser global del server es de 256kb; un lote de hasta 2000 filas no
// cabe ahí. El POST de creación está en LARGE_BODY_POST_PATHS (server.ts) para
// saltar el parser global, y monta este parser ampliado. 4mb cubre el caso
// esperado de 2000 filas con holgura (rowSchema es passthrough, así que extras
// arbitrarios podrían inflar más). Endpoint autenticado (no anónimo).
const jsonLargeBatch = json({ limit: "4mb" });

// Fila de entrada (fase 1: JSON estructurado). Cotas sanas; los campos abiertos
// extra se conservan en el crudo. La identidad mínima (nombre + hospital
// resoluble) se valida en el worker, no aquí, para registrar el error por-fila
// en vez de tumbar todo el lote.
const rowSchema = z
  .object({
    hospital: z.string().trim().max(200).optional(),
    hospitalId: z.string().trim().max(120).optional(),
    name: z.string().trim().max(200).optional(),
    age: z.union([z.number(), z.string().max(10)]).nullable().optional(),
    condition: z.string().trim().max(60).optional(),
    status: z.string().trim().max(60).optional(),
    // Documento/cédula — SENSIBLE: se queda en staging restringido, no público.
    documentId: z.string().trim().max(60).optional(),
    notes: z.string().max(600).optional(),
    contact: z.string().max(120).optional(),
  })
  .passthrough();

const createSchema = z.object({
  // `source` = etiqueta DECLARADA del origen del lote (p.ej. "telegram",
  // "archivo-hospital-x"). La declara el cliente y NO es confiable: nunca
  // representa autoría ni se usa para auth/dedup. La autoría VERIFICADA es el
  // usuario autenticado (`created_by`, derivado de req.user en el route + en el
  // audit_log). El modelado rico de procedencia (canal + referencia por-fila)
  // está propuesto en docs/rfcs/0006-procedencia-ingesta-pacientes.md (#151).
  source: z.string().trim().max(120).optional(),
  // C7: fase 1 SOLO procesa JSON estructurado. Si el cliente declara otro
  // contentType (p.ej. "text/csv"), lo rechazamos con 400 en vez de procesar el
  // payload como JSON silenciosamente. Cuando entren CSV/XLSX (Fase 4) se amplía
  // el set permitido.
  contentType: z
    .string()
    .trim()
    .max(120)
    .optional()
    .refine((v) => v === undefined || v === "application/json", {
      message: 'Solo se admite contentType "application/json" en esta fase.',
    }),
  rows: z.array(rowSchema).min(1, "Envía al menos una fila.").max(2000, "Máximo 2000 filas por lote."),
});

const idempotencyKeyHeader = z.object({
  "idempotency-key": z.string().trim().min(1).max(200).optional(),
});

const idParams = z.object({ id: z.string().trim().min(1, "Falta el id.") });
const rowsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * @swagger
 * /api/public/patient-imports:
 *   post:
 *     summary: Crear un lote de importación de pacientes (capability patient:import)
 *     description: >
 *       Recibe filas estructuradas (JSON), las guarda en staging y encola el
 *       procesado (normalización + validación + deduplicación). Responde 202; el
 *       resultado se consulta por id. No escribe pacientes finales hasta el apply.
 *     tags: [Public:PatientImports]
  *     security: [{ bearerAuth: [] }]
  *     parameters:
  *       - name: Idempotency-Key
  *         in: header
  *         required: false
  *         schema: { type: string, maxLength: 200 }
  *         description: >
  *           Clave de retry del cliente. Se guarda solo como hash SHA-256 y es
  *           única por usuario autenticado; repetirla devuelve el mismo lote.
  *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rows]
 *             properties:
 *               source:
 *                 type: string
 *                 description: >
 *                   Etiqueta DECLARADA del origen del lote (no confiable, no es
 *                   autoría). La autoría verificada es el usuario autenticado
 *                   (created_by). Default "api".
 *               contentType:
 *                 type: string
 *                 description: >
 *                   Solo "application/json" en esta fase (default). Otro valor
 *                   responde 400. CSV/XLSX llegarán en una fase posterior.
 *               rows:
 *                 type: array
 *                 items: { type: object }
 *     responses:
 *       202: { description: Lote aceptado y encolado para procesar }
 *       400: { description: Datos inválidos }
 *       401: { description: No autenticado }
 *       403: { description: Sin capacidad patient:import }
 *       503: { description: No se pudo encolar (cola no disponible) }
 */
patientImportsRouter.post(
  "/",
  rateLimit({ scope: "public:patient-import:create", limit: 30 }),
  requireCapability("patient:import"),
  jsonLargeBatch, // parser 4mb (tras los gates: no parseamos 4mb para callers rechazados)
  validate({ body: createSchema }),
  asyncHandler(async (req, res) => {
    const parsedHeaders = idempotencyKeyHeader.safeParse(req.headers);
    if (!parsedHeaders.success) throw badRequest("Idempotency-Key inválido.");
    const headers = parsedHeaders.data;
    const body = {
      ...(req.body as z.infer<typeof createSchema>),
      idempotencyKey: headers["idempotency-key"],
    };
    const created = await service.createImport(body, req.user?.id ?? null);
    const { reusedExisting, ...summary } = created;
    if (reusedExisting) {
      res.status(202).json({ import: summary, jobId: summary.jobId });
      return;
    }
    let jobId: string;
    try {
      jobId = await enqueuePatientImport({ importId: summary.id, mode: "process" });
    } catch {
      // D4: no dejar el lote huérfano en `pending` sin job. Lo sellamos `failed`
      // para que la API lo refleje y no quede colgado para siempre.
      await service.markImportFailed(summary.id, "No se pudo encolar el procesamiento.", "process");
      throw serviceUnavailable("No se pudo encolar la importación. Inténtalo de nuevo.");
    }
    // D4: marca queued (condicional: no pisa al worker si ya arrancó) + jobId.
    await service.markImportQueued(summary.id, jobId);
    await writeAudit(req, {
      action: "patient-import.create",
      targetType: "patient-import",
      targetId: summary.id,
      metadata: { rows: summary.counts.total, source: summary.source },
    });
    res.status(202).json({ import: { ...summary, status: "queued", jobId }, jobId });
  }),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}:
 *   get:
 *     summary: Estado y contadores de un lote (capability patient:import)
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Resumen del lote (sin PII) }
 *       404: { description: No encontrado }
 */
patientImportsRouter.get(
  "/:id",
  rateLimit({ scope: "public:patient-import:get", limit: 120 }),
  requireCapability("patient:import"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const summary = await service.getImport((req.params as { id: string }).id);
    if (!summary) throw notFound("Lote de importación no encontrado.");
    res.json({ import: summary });
  }),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/rows:
 *   get:
 *     summary: Filas del lote con su estado de validación/dedup (capability patient:import)
 *     description: >
 *       Devuelve las filas REDACTADAS — estado, errores y avisos de revisión.
 *       Nunca expone el dato crudo, el documento/cédula, las notas ni el contacto.
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *       - { name: limit, in: query, schema: { type: integer } }
 *       - { name: offset, in: query, schema: { type: integer } }
 *     responses:
 *       200: { description: Filas redactadas del lote }
 *       404: { description: No encontrado }
 */
patientImportsRouter.get(
  "/:id/rows",
  rateLimit({ scope: "public:patient-import:rows", limit: 120 }),
  requireCapability("patient:import"),
  validate({ params: idParams, query: rowsQuery }),
  asyncHandler(async (req, res) => {
    const id = (req.params as { id: string }).id;
    const exists = await service.getImport(id);
    if (!exists) throw notFound("Lote de importación no encontrado.");
    const q = req.query as z.infer<typeof rowsQuery>;
    const rows = await service.listImportRows(id, { limit: q.limit, offset: q.offset });
    res.json({ items: rows });
  }),
);

/**
 * @swagger
 * /api/public/patient-imports/{id}/apply:
 *   post:
 *     summary: Aplicar las filas válidas y únicas del lote (capability patient:import)
 *     description: >
 *       Encola el apply, que escribe SOLO las filas válidas y únicas en
 *       hospital_patients de forma idempotente (re-aplicar no duplica). Las filas
 *       inválidas, duplicadas o en revisión se omiten. Responde 202.
 *     tags: [Public:PatientImports]
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: id, in: path, required: true, schema: { type: string } }
 *     responses:
  *       202: { description: Apply encolado }
  *       400: { description: El lote aún no está procesado o no es reanudable }
 *       404: { description: No encontrado }
 *       503: { description: No se pudo encolar (cola no disponible) }
 */
patientImportsRouter.post(
  "/:id/apply",
  rateLimit({ scope: "public:patient-import:apply", limit: 30 }),
  requireCapability("patient:import"),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const id = (req.params as { id: string }).id;
    const summary = await service.getImport(id);
    if (!summary) throw notFound("Lote de importación no encontrado.");
    // Solo se aplica un lote ya procesado (o re-aplicar uno ya aplicado, que es
    // idempotente). Bloquea estados intermedios para no escribir sobre staging
    // a medio evaluar.
    if (
      !["processed", "applied"].includes(summary.status) &&
      !(summary.status === "failed" && summary.failedStage === "apply")
    ) {
      throw badRequest(
        `El lote está en estado "${summary.status}"; debe estar "processed" o fallido en etapa "apply" para aplicar.`,
      );
    }
    let jobId: string;
    try {
      jobId = await enqueuePatientImport({
        importId: id,
        mode: "apply",
        actorId: req.user?.id ?? null,
      });
    } catch {
      throw serviceUnavailable("No se pudo encolar el apply. Inténtalo de nuevo.");
    }
    await service.setImportJob(id, jobId);
    await writeAudit(req, {
      action: "patient-import.apply",
      targetType: "patient-import",
      targetId: id,
      metadata: { valid: summary.counts.valid },
    });
    res.status(202).json({ jobId });
  }),
);
