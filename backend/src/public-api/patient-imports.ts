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
import { notFound, badRequest, serviceUnavailable, notImplemented } from "@/lib/errors";
import { writeAudit } from "@/auth/audit";
import { enqueuePatientImport } from "@/lib/queues";
import * as service from "@/services/patient-imports";
import {
  CONTENT_TYPE,
  FILE_CONTENT_TYPES,
  ImportParseError,
  MAX_IMPORT_ROWS,
  isOcrPendingContentType,
  parseImportFile,
} from "@/services/patient-import-parse";
import type { RawPatientRow } from "@/services/patient-import-logic";
import { getMinimaxOcrConfig } from "@/services/ocr/minimax-config";

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

// base64 de hasta ~4MB de archivo cabe en el body de 4mb (overhead ~33%). Cota
// dura para rechazar temprano antes de decodificar (defensa en profundidad junto
// a las cotas del parser).
const MAX_FILE_BASE64_LEN = 4_000_000;

const SUPPORTED_CONTENT_TYPES: ReadonlySet<string> = new Set([
  CONTENT_TYPE.JSON,
  CONTENT_TYPE.CSV,
  CONTENT_TYPE.XLSX,
]);

/** ¿Es un contentType de imagen (image/*) — el único OCR cableado por URL? */
function isImageContentType(contentType: string | undefined): boolean {
  return contentType !== undefined && contentType.trim().toLowerCase().startsWith("image/");
}

const createSchema = z
  .object({
    // `source` = etiqueta DECLARADA del origen del lote (p.ej. "telegram",
    // "archivo-hospital-x"). La declara el cliente y NO es confiable: nunca
    // representa autoría ni se usa para auth/dedup. La autoría VERIFICADA es el
    // usuario autenticado (`created_by`, derivado de req.user en el route + en el
    // audit_log). El modelado rico de procedencia (canal + referencia por-fila)
    // está propuesto en docs/rfcs/0006-procedencia-ingesta-pacientes.md (#151).
    source: z.string().trim().max(120).optional(),
    // Fase 4: se admite JSON estructurado (`rows`) o un archivo TABULAR CSV/XLSX
    // (`fileBase64`). Otro contentType se rechaza con 400 (no se procesa a ciegas).
    contentType: z
      .string()
      .trim()
      .max(120)
      .optional()
      .refine((v) => v === undefined || SUPPORTED_CONTENT_TYPES.has(v) || isOcrPendingContentType(v), {
        message: 'contentType admitido: "application/json", "text/csv" o XLSX.',
      }),
    // JSON estructurado: filas directas (camino histórico, sin regresión).
    rows: z
      .array(rowSchema)
      .min(1, "Envía al menos una fila.")
      .max(MAX_IMPORT_ROWS, `Máximo ${MAX_IMPORT_ROWS} filas por lote.`)
      .optional(),
    // CSV/XLSX: el archivo va en base64 (sin multipart). Se parsea a `rows` en el
    // route (acotado) ANTES de encolar; el trabajo pesado sigue en el worker.
    fileBase64: z.string().max(MAX_FILE_BASE64_LEN, "Archivo demasiado grande.").optional(),
    // OCR/ICR (imagen): URL http/https de la imagen a extraer. SOLO para
    // contentType image/*. No se acepta base64/rows para OCR en esta fase: la URL
    // viaja al worker en el payload del job y NUNCA se persiste ni se expone.
    imageUrl: z
      .string()
      .trim()
      .max(2048)
      .url("imageUrl debe ser una URL válida.")
      .refine((v) => /^https?:\/\//i.test(v), { message: "imageUrl debe ser http o https." })
      .optional(),
  })
  .superRefine((val, ctx) => {
    // `imageUrl` solo aplica a OCR de imagen (contentType image/*). En cualquier
    // otro formato es un campo fuera de lugar → 400 claro.
    if (val.imageUrl !== undefined && !isImageContentType(val.contentType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["imageUrl"],
        message: "imageUrl solo aplica a contentType image/* (OCR/ICR).",
      });
    }
    // OCR/ICR (imagen/PDF): no se valida rows/fileBase64/imageUrl aquí; la
    // habilitación del proveedor y la presencia de imageUrl las decide el route
    // (para que con OCR deshabilitado siga respondiendo 501, no 400).
    if (val.contentType !== undefined && isOcrPendingContentType(val.contentType)) return;
    const isFile = val.contentType !== undefined && FILE_CONTENT_TYPES.has(val.contentType);
    if (isFile) {
      if (!val.fileBase64) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fileBase64"],
          message: "Para CSV/XLSX envía el archivo en fileBase64.",
        });
      }
      if (val.rows !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows"],
          message: "Para CSV/XLSX usa fileBase64, no rows.",
        });
      }
    } else {
      // JSON (explícito o por defecto): exige `rows` y prohíbe `fileBase64`.
      if (!val.rows) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows"],
          message: "Envía al menos una fila.",
        });
      }
      if (val.fileBase64 !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fileBase64"],
          message: "fileBase64 solo aplica a CSV/XLSX.",
        });
      }
    }
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
 *       Recibe filas estructuradas en JSON (`rows`) o un archivo TABULAR CSV/XLSX
 *       en base64 (`fileBase64`), las guarda en staging y encola el procesado
 *       (normalización + validación + deduplicación). Responde 202; el resultado se
 *       consulta por id. No escribe pacientes finales hasta el apply. CSV/XLSX se
 *       parsean en el route (acotado) a la misma forma que el JSON; un archivo
 *       ilegible falla el LOTE con 400. No hay OCR en esta fase: una imagen o PDF
 *       (OCR/ICR) NO está habilitado y se rechaza con 501; requiere revisión humana.
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
 *             properties:
 *               source:
 *                 type: string
 *                 description: >
 *                   Etiqueta DECLARADA del origen del lote (no confiable, no es
 *                   autoría). La autoría verificada es el usuario autenticado
 *                   (created_by). Default "api".
 *               contentType:
 *                 type: string
 *                 enum:
 *                   - application/json
 *                   - text/csv
 *                   - application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
 *                 description: >
 *                   Formato del payload (default "application/json"). Con JSON envía
 *                   "rows"; con "text/csv" o XLSX envía "fileBase64". Otro valor
 *                   responde 400.
 *               rows:
 *                 type: array
 *                 description: Filas estructuradas (solo JSON). Excluyente con fileBase64.
 *                 items: { type: object }
 *               fileBase64:
 *                 type: string
 *                 description: >
 *                   Archivo CSV/XLSX TABULAR (primera fila = cabecera) en base64.
 *                   Solo para CSV/XLSX. Excluyente con rows.
 *               imageUrl:
 *                 type: string
 *                 description: >
 *                   URL http/https de la imagen a extraer por OCR/ICR. Solo para
 *                   contentType image/* y solo si hay un proveedor OCR configurado.
 *                   Las filas extraídas SIEMPRE quedan en revisión (nunca se
 *                   auto-aplican). La URL no se persiste ni se expone en respuestas.
 *     responses:
 *       202: { description: Lote aceptado y encolado para procesar (incluye OCR de imagen vía imageUrl) }
 *       400: { description: Datos inválidos (p.ej. imagen sin imageUrl, o imageUrl en un formato no-imagen) }
 *       401: { description: No autenticado }
 *       403: { description: Sin capacidad patient:import }
 *       501: { description: OCR/ICR no habilitado (proveedor ausente) o PDF; requiere revisión humana }
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
    const parsed = req.body as z.infer<typeof createSchema>;

    // OCR/ICR (imagen/PDF). El reconocimiento de imágenes/PDF y de texto MANUSCRITO
    // exige SIEMPRE revisión humana (#151/#158): la entrada OCR jamás auto-aplica ni
    // llega a "valid". En esta fase SOLO está cableada la imagen vía URL (image/* +
    // imageUrl) y solo si hay un proveedor OCR configurado:
    //   - proveedor deshabilitado  → 501 (sin habilitar nada, sin persistir).
    //   - PDF                      → 501 (sin contrato de almacenamiento/URL todavía).
    //   - imagen sin imageUrl      → 400 (no se acepta base64/rows para OCR).
    // La URL de imagen NO se persiste: viaja al worker en el payload del job.
    if (parsed.contentType !== undefined && isOcrPendingContentType(parsed.contentType)) {
      const ocrConfig = getMinimaxOcrConfig();
      const isImage = isImageContentType(parsed.contentType);
      if (!ocrConfig || !isImage) {
        throw notImplemented(
          "Importación por OCR/ICR (imagen o PDF) no está habilitada en este servidor. " +
            "El reconocimiento de imágenes/PDF y de texto manuscrito requiere revisión humana. " +
            "Por ahora envía datos tabulares: JSON (rows) o un archivo CSV/XLSX (fileBase64).",
        );
      }
      if (!parsed.imageUrl) {
        throw badRequest(
          "Para OCR/ICR de imagen envía imageUrl (URL http/https). No se acepta base64 ni rows en esta fase.",
        );
      }
      if (parsed.fileBase64 !== undefined || parsed.rows !== undefined) {
        throw badRequest("Para OCR/ICR de imagen usa solo imageUrl (sin fileBase64 ni rows).");
      }

      // Lote OCR: se crea SIN filas (las extrae el worker desde la imagen) y se
      // encola un job "ocr". La imageUrl va en el payload del job, nunca a la DB.
      const created = await service.createImport(
        {
          source: parsed.source,
          contentType: parsed.contentType,
          rows: [],
          idempotencyKey: headers["idempotency-key"],
        },
        req.user?.id ?? null,
      );
      const { reusedExisting, ...summary } = created;
      if (reusedExisting) {
        res.status(202).json({ import: summary, jobId: summary.jobId });
        return;
      }
      let ocrJobId: string;
      try {
        ocrJobId = await enqueuePatientImport({
          importId: summary.id,
          mode: "ocr",
          imageUrl: parsed.imageUrl,
        });
      } catch {
        await service.markImportFailed(summary.id, "No se pudo encolar el OCR/ICR.", "process");
        throw serviceUnavailable("No se pudo encolar la importación OCR. Inténtalo de nuevo.");
      }
      await service.markImportQueued(summary.id, ocrJobId);
      // Auditoría: NO se registra la imageUrl (dato sensible de origen), solo el id.
      await writeAudit(req, {
        action: "patient-import.create",
        targetType: "patient-import",
        targetId: summary.id,
        metadata: { source: summary.source, contentType: summary.contentType, ocr: true },
      });
      res.status(202).json({ import: { ...summary, status: "queued", jobId: ocrJobId }, jobId: ocrJobId });
      return;
    }

    // CSV/XLSX: el archivo (fileBase64) se materializa a `rows` aquí, en el route
    // (parse ACOTADO, sin OCR), reutilizando todo el pipeline JSON. Un archivo
    // ilegible/vacío falla el LOTE con 400 (error claro por-lote); los problemas
    // de fila siguen resolviéndose por-fila en el worker. JSON pasa sin tocar.
    let rows: RawPatientRow[];
    if (parsed.fileBase64 !== undefined && parsed.contentType !== undefined) {
      try {
        rows = parseImportFile(parsed.contentType, parsed.fileBase64);
      } catch (err) {
        if (err instanceof ImportParseError) throw badRequest(err.message);
        throw err;
      }
      // Las filas parseadas de CSV/XLSX deben respetar las MISMAS cotas que las del
      // JSON (`z.array(rowSchema)` en `createSchema`). Reusamos el schema en vez de
      // duplicar reglas: un campo excedido (p.ej. notes > 600) falla el LOTE con un
      // 400 claro, igual que el JSON, en vez de colarse a staging.
      const validatedRows = z.array(rowSchema).safeParse(rows);
      if (!validatedRows.success) {
        const issue = validatedRows.error.issues[0];
        const where = issue ? issue.path.join(".") : "fila";
        throw badRequest(`El archivo tiene filas que exceden los límites permitidos (${where}).`);
      }
      rows = validatedRows.data;
    } else {
      rows = parsed.rows ?? [];
    }

    const body = {
      source: parsed.source,
      contentType: parsed.contentType,
      rows,
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
