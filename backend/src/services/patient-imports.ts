/**
 * Service de importación de pacientes hospitalarios (#151) — orquestación con DB.
 *
 * Flujo: la API recibe un lote (JSON estructurado) → `createImport` lo guarda en
 * STAGING (`patient_imports` + `patient_import_rows`) crudo/pending y encola un
 * job. El worker corre `processImport` (normaliza, valida, deduplica, actualiza
 * contadores) y luego, bajo demanda, `applyImport` escribe SOLO las filas
 * válidas y únicas en `hospital_patients` de forma idempotente.
 *
 * Privacidad: el dato crudo y los campos sensibles (documento/cédula, notas,
 * contacto) viven en `raw_data` (restringido). Los DTO de salida son allowlists
 * que NUNCA exponen ese material — solo estado, contadores y errores/avisos de
 * revisión. No se propaga el documento al paciente final (no empeora el TODO de
 * PII de notas).
 */

import { createHash, randomUUID } from "crypto";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { env } from "@/config/env";
import { getDb, schema } from "@/db";
import type { PatientCondition, PatientStatus } from "@/services/patients";
import {
  classifyDedup,
  hashDocumentDigits,
  nameKey,
  normalizeRow,
  resolveHospitalAlias,
  validateRow,
  type DedupCandidate,
  type NormalizedRow,
  type RawPatientRow,
} from "@/services/patient-import-logic";
import { isOcrPendingContentType } from "@/services/patient-import-parse";
import { getMinimaxOcrConfig, type MinimaxOcrConfig } from "@/services/ocr/minimax-config";
import {
  extractPatientRowsFromImageUrl,
  OCR_REVIEW_WARNING,
  type FetchLike,
} from "@/services/ocr/minimax-provider";

const { patientImports, patientImportRows, hospitalPatients, hospitals } = schema;

const PATIENT_IMPORT_FAILED_STAGE = {
  PROCESS: "process",
  APPLY: "apply",
} as const;

type PatientImportFailedStage =
  (typeof PATIENT_IMPORT_FAILED_STAGE)[keyof typeof PATIENT_IMPORT_FAILED_STAGE];

const PATIENT_CONDITION = {
  STABLE: "stable",
  SERIOUS: "serious",
  CRITICAL: "critical",
  RECOVERING: "recovering",
  UNKNOWN: "unknown",
} as const;

const PATIENT_STATUS = {
  HOSPITALIZED: "hospitalized",
  DISCHARGED: "discharged",
  TRANSFERRED: "transferred",
  DECEASED: "deceased",
} as const;

const PATIENT_CONDITIONS = new Set<string>(Object.values(PATIENT_CONDITION));
const PATIENT_STATUSES = new Set<string>(Object.values(PATIENT_STATUS));

/** Estados de cabecera del import. */
export type ImportStatus =
  | "pending"
  | "queued"
  | "processing"
  | "processed"
  | "applying"
  | "applied"
  | "failed";

/** DTO de salida de la cabecera (allowlist, sin PII). */
export interface ImportSummaryDTO {
  id: string;
  status: ImportStatus;
  source: string;
  contentType: string;
  jobId: string | null;
  failedStage: PatientImportFailedStage | null;
  counts: {
    total: number;
    valid: number;
    invalid: number;
    duplicate: number;
    review: number;
    applied: number;
  };
  createdBy: string | null;
  errorSummary: string | null;
  createdAt: number;
  processedAt: number | null;
  appliedAt: number | null;
  updatedAt: number;
}

/** DTO de salida de una fila staging (REDACTADO: sin crudo/documento/notas/contacto). */
export interface ImportRowDTO {
  id: string;
  rowIndex: number;
  name: string;
  age: number | null;
  condition: string | null;
  status: string | null;
  sourceHospital: string;
  hospitalId: string | null;
  rowStatus: string;
  dedupStatus: string;
  confidence: number;
  validationErrors: string[];
  validationWarnings: string[];
  dedupCandidates: { patientId: string; name: string; reason?: string }[];
  patientId: string | null;
}

export interface CreateImportInput {
  source?: string;
  contentType?: string;
  idempotencyKey?: string;
  rows: RawPatientRow[];
}

export interface CreateImportResult extends ImportSummaryDTO {
  reusedExisting: boolean;
}

interface ImportHeaderRow {
  id: string;
  status: string;
  source: string;
  contentType: string;
  jobId: string | null;
  failedStage: string | null;
  idempotencyKeyHash: string | null;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  duplicateRows: number;
  reviewRows: number;
  appliedRows: number;
  createdBy: string | null;
  errorSummary: string | null;
  createdAt: number;
  processedAt: number | null;
  appliedAt: number | null;
  updatedAt: number;
}

function toSummary(h: ImportHeaderRow): ImportSummaryDTO {
  return {
    id: h.id,
    status: h.status as ImportStatus,
    source: h.source,
    contentType: h.contentType,
    jobId: h.jobId,
    failedStage: isFailedStage(h.failedStage) ? h.failedStage : null,
    counts: {
      total: h.totalRows,
      valid: h.validRows,
      invalid: h.invalidRows,
      duplicate: h.duplicateRows,
      review: h.reviewRows,
      applied: h.appliedRows,
    },
    createdBy: h.createdBy,
    errorSummary: h.errorSummary,
    createdAt: h.createdAt,
    processedAt: h.processedAt,
    appliedAt: h.appliedAt,
    updatedAt: h.updatedAt,
  };
}

function toCreateImportResult(
  h: ImportHeaderRow,
  reusedExisting: boolean,
): CreateImportResult {
  return { ...toSummary(h), reusedExisting };
}

function isFailedStage(value: string | null): value is PatientImportFailedStage {
  return value === PATIENT_IMPORT_FAILED_STAGE.PROCESS || value === PATIENT_IMPORT_FAILED_STAGE.APPLY;
}

function hashIdempotencyKey(key: string | undefined): string | null {
  const trimmed = key?.trim();
  if (!trimmed) return null;
  return createHash("sha256").update(trimmed).digest("hex");
}

/**
 * HMAC del documento a partir de sus dígitos normalizados. Degrada a `null` si no
 * hay dígitos útiles o si falta el secreto (dev local sin configurar): en ese
 * caso simplemente no hay dedup exacta por documento, nunca rompe el flujo. En
 * producción el secreto es obligatorio (validado en `env.ts`).
 */
function documentHashFor(digits: string | null): string | null {
  if (!digits) return null;
  const secret = env.PATIENT_DOCUMENT_HASH_SECRET;
  if (!secret) return null;
  return hashDocumentDigits(digits, secret);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}

function assertImportState(
  header: ImportHeaderRow,
  allowed: readonly ImportStatus[],
  action: string,
): void {
  if (!allowed.includes(header.status as ImportStatus)) {
    throw new Error(
      `No se puede ${action} un lote en estado "${header.status}"; estados válidos: ${allowed.join(", ")}.`,
    );
  }
}

interface QueryRows<T> {
  rows: T[];
}

async function lockHeaderForUpdate(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  importId: string,
): Promise<ImportHeaderRow | null> {
  const result = (await tx.execute(sql`
    select
      id,
      status,
      source,
      content_type as "contentType",
      job_id as "jobId",
      failed_stage as "failedStage",
      idempotency_key_hash as "idempotencyKeyHash",
      total_rows as "totalRows",
      valid_rows as "validRows",
      invalid_rows as "invalidRows",
      duplicate_rows as "duplicateRows",
      review_rows as "reviewRows",
      applied_rows as "appliedRows",
      created_by as "createdBy",
      error_summary as "errorSummary",
      created_at as "createdAt",
      processed_at as "processedAt",
      applied_at as "appliedAt",
      updated_at as "updatedAt"
    from patient_imports
    where id = ${importId}
    for update
  `)) as unknown as QueryRows<ImportHeaderRow>;
  return result.rows[0] ?? null;
}

async function transitionImportStatus(
  importId: string,
  allowed: readonly ImportStatus[],
  nextStatus: ImportStatus,
  action: string,
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const header = await lockHeaderForUpdate(tx, importId);
    if (!header) throw new Error(`patient_import ${importId} no existe`);
    if (header.status === nextStatus) return false;
    assertImportState(header, allowed, action);
    await tx
      .update(patientImports)
      .set({ status: nextStatus, failedStage: null, updatedAt: Date.now() })
      .where(eq(patientImports.id, importId));
    return true;
  });
}

/**
 * Crea un lote en STAGING (cabecera + filas crudas) en estado `pending`. NO
 * procesa nada inline (el worker lo hace): devuelve la cabecera para que la API
 * responda 202 con el id a consultar.
 */
export async function createImport(
  input: CreateImportInput,
  actorId: string | null,
): Promise<CreateImportResult> {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();
  const idempotencyKeyHash = hashIdempotencyKey(input.idempotencyKey);

  if (idempotencyKeyHash && actorId) {
    const existing = await db
      .select()
      .from(patientImports)
      .where(
        and(
          eq(patientImports.createdBy, actorId),
          eq(patientImports.idempotencyKeyHash, idempotencyKeyHash),
        ),
      )
      .limit(1);
    if (existing[0]) return toCreateImportResult(existing[0] as ImportHeaderRow, true);
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(patientImports).values({
        id,
        status: "pending",
        source: (input.source ?? "api").slice(0, 120),
        contentType: (input.contentType ?? "application/json").slice(0, 120),
        idempotencyKeyHash,
        totalRows: input.rows.length,
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
      });

      if (input.rows.length > 0) {
        await tx.insert(patientImportRows).values(
          input.rows.map((raw, i) => ({
            id: randomUUID(),
            importId: id,
            rowIndex: i,
            rawData: raw as Record<string, unknown>,
            createdAt: now,
            updatedAt: now,
          })),
        );
      }
    });
  } catch (err) {
    if (!isUniqueViolation(err) || !idempotencyKeyHash || !actorId) throw err;
    const existing = await db
      .select()
      .from(patientImports)
      .where(
        and(
          eq(patientImports.createdBy, actorId),
          eq(patientImports.idempotencyKeyHash, idempotencyKeyHash),
        ),
      )
      .limit(1);
    if (existing[0]) return toCreateImportResult(existing[0] as ImportHeaderRow, true);
    throw err;
  }

  const header = await loadHeader(id);
  return toCreateImportResult(header!, false);
}

async function loadHeader(id: string): Promise<ImportHeaderRow | null> {
  const db = getDb();
  const rows = await db.select().from(patientImports).where(eq(patientImports.id, id)).limit(1);
  return (rows[0] as ImportHeaderRow | undefined) ?? null;
}

/** Cabecera por id (DTO allowlist) o null. */
export async function getImport(id: string): Promise<ImportSummaryDTO | null> {
  const header = await loadHeader(id);
  return header ? toSummary(header) : null;
}

/** Marca el jobId del último job encolado (trazabilidad). */
export async function setImportJob(id: string, jobId: string): Promise<void> {
  const db = getDb();
  await db
    .update(patientImports)
    .set({ jobId, updatedAt: Date.now() })
    .where(eq(patientImports.id, id));
}

/**
 * Tras encolar el `process` con éxito (D4): registra el jobId SIEMPRE y avanza el
 * estado `pending → queued` de forma CONDICIONAL. El `case` evita una carrera: si
 * el worker ya arrancó y dejó el lote en `processing`/`processed`, este UPDATE no
 * lo pisa (solo promueve desde `pending`). Así el estado nunca retrocede.
 */
export async function markImportQueued(id: string, jobId: string): Promise<void> {
  const db = getDb();
  await db
    .update(patientImports)
    .set({
      jobId,
      status: sql`case when ${patientImports.status} = 'pending' then 'queued' else ${patientImports.status} end`,
      updatedAt: Date.now(),
    })
    .where(eq(patientImports.id, id));
}

interface StagingRow {
  id: string;
  rowIndex: number;
  name: string;
  age: number | null;
  condition: string | null;
  status: string | null;
  sourceHospital: string;
  hospitalId: string | null;
  rowStatus: string;
  dedupStatus: string;
  confidence: number;
  validationErrors: unknown;
  validationWarnings: unknown;
  dedupCandidates: unknown;
  patientId: string | null;
}

function toRowDTO(r: StagingRow): ImportRowDTO {
  const candidates = Array.isArray(r.dedupCandidates)
    ? (r.dedupCandidates as DedupCandidate[]).map((c) => ({
        patientId: c.patientId,
        name: c.name,
        reason: c.reason,
      }))
    : [];
  return {
    id: r.id,
    rowIndex: r.rowIndex,
    name: r.name,
    age: r.age,
    condition: r.condition,
    status: r.status,
    sourceHospital: r.sourceHospital,
    hospitalId: r.hospitalId,
    rowStatus: r.rowStatus,
    dedupStatus: r.dedupStatus,
    confidence: r.confidence,
    validationErrors: Array.isArray(r.validationErrors) ? (r.validationErrors as string[]) : [],
    validationWarnings: Array.isArray(r.validationWarnings)
      ? (r.validationWarnings as string[])
      : [],
    dedupCandidates: candidates,
    patientId: r.patientId,
  };
}

/**
 * Filas staging (DTO REDACTADO). Paginado simple por offset/limit acotados. El
 * dato crudo y los campos sensibles NUNCA salen por aquí.
 */
export async function listImportRows(
  importId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ImportRowDTO[]> {
  const db = getDb();
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const rows = await db
    .select({
      id: patientImportRows.id,
      rowIndex: patientImportRows.rowIndex,
      name: patientImportRows.name,
      age: patientImportRows.age,
      condition: patientImportRows.condition,
      status: patientImportRows.status,
      sourceHospital: patientImportRows.sourceHospital,
      hospitalId: patientImportRows.hospitalId,
      rowStatus: patientImportRows.rowStatus,
      dedupStatus: patientImportRows.dedupStatus,
      confidence: patientImportRows.confidence,
      validationErrors: patientImportRows.validationErrors,
      validationWarnings: patientImportRows.validationWarnings,
      dedupCandidates: patientImportRows.dedupCandidates,
      patientId: patientImportRows.patientId,
    })
    .from(patientImportRows)
    .where(eq(patientImportRows.importId, importId))
    .orderBy(asc(patientImportRows.rowIndex))
    .limit(limit)
    .offset(offset);
  return (rows as StagingRow[]).map(toRowDTO);
}

// --------------------------------------------------------------------------
// OCR/ICR (lo corre el worker): extrae filas de una imagen y las materializa en
// staging como review-required, luego corre el process. Aislado del request path.
// --------------------------------------------------------------------------

/**
 * Reemplaza las filas de staging de un lote con las extraídas por OCR. Operación
 * idempotente frente a reintentos del job: borra las filas previas del lote y
 * reinserta el crudo extraído (la re-extracción puede diferir), actualizando
 * `total_rows`. NO normaliza ni valida — eso lo hace `processImport` después.
 */
async function replaceStagingRows(importId: string, rows: RawPatientRow[]): Promise<void> {
  const db = getDb();
  const now = Date.now();
  await db.transaction(async (tx) => {
    await tx.delete(patientImportRows).where(eq(patientImportRows.importId, importId));
    if (rows.length > 0) {
      await tx.insert(patientImportRows).values(
        rows.map((raw, i) => ({
          id: randomUUID(),
          importId,
          rowIndex: i,
          rawData: raw as Record<string, unknown>,
          createdAt: now,
          updatedAt: now,
        })),
      );
    }
    await tx
      .update(patientImports)
      .set({ totalRows: rows.length, updatedAt: now })
      .where(eq(patientImports.id, importId));
  });
}

/** Deps inyectables del ingest OCR (tests mockean fetch/extractor sin red ni env). */
export interface OcrIngestDeps {
  /** fetch mockeable que se pasa al proveedor. */
  fetch?: FetchLike;
  /** Config resuelta. `undefined` => se resuelve de env; `null` => OCR deshabilitado. */
  config?: MinimaxOcrConfig | null;
  /** Extractor inyectable (default: el proveedor Minimax real). */
  extract?: typeof extractPatientRowsFromImageUrl;
}

/**
 * Ingesta OCR/ICR de un lote ya creado: llama al proveedor con la URL de imagen,
 * materializa las filas extraídas en staging y corre el `process`. NO sella el
 * lote como fallido aquí: si lanza, deja que el worker reintente (BullMQ) y selle
 * `failed` solo en el último intento, evitando dejar el lote en un estado del que
 * `processImport` no pueda re-arrancar. La URL de imagen NUNCA se persiste.
 *
 * INVARIANTE: las filas resultantes SIEMPRE quedan en revisión (lo fuerza
 * `processImport` al detectar el contentType OCR del lote). Nada se auto-aplica.
 */
export async function ingestOcrImport(
  importId: string,
  imageUrl: string | undefined,
  deps: OcrIngestDeps = {},
): Promise<ImportSummaryDTO> {
  const config = deps.config !== undefined ? deps.config : getMinimaxOcrConfig();
  if (!config) throw new Error("OCR provider not configured.");
  if (!imageUrl) throw new Error("Missing image URL for OCR extraction.");

  const extract = deps.extract ?? extractPatientRowsFromImageUrl;
  const result = await extract(config, imageUrl, { fetch: deps.fetch });

  await replaceStagingRows(importId, result.rows);
  return processImport(importId);
}

// --------------------------------------------------------------------------
// Procesado (lo corre el worker): normaliza, valida, deduplica, actualiza.
// --------------------------------------------------------------------------

interface RawStagingRow {
  id: string;
  rowIndex: number;
  rawData: unknown;
}

interface NameMatch {
  id: string;
  count: number;
}

/**
 * C6 (#151) — Resuelve el hospital de TODAS las filas del lote en a lo sumo DOS
 * queries (una por id explícito, una por nombre), evitando el N+1 que producía
 * resolver fila por fila en lotes grandes. Devuelve un arreglo alineado a `norms`
 * (mismo índice => mismo hospital resuelto o `null`).
 *
 * Preserva exactamente la semántica por fila anterior:
 *   - id explícito que existe en `hospitals` gana (no se consulta el nombre);
 *   - si no, nombre exacto case-insensitive (con alias curado previo);
 *   - regla de ambigüedad intacta: una clave de nombre que matchea 0 o ≥2
 *     hospitales queda SIN resolver (el operador desambigua con el id explícito,
 *     evita asignar al hospital equivocado).
 */
async function resolveHospitalIdsForBatch(
  norms: NormalizedRow[],
): Promise<(string | null)[]> {
  const db = getDb();

  // 1) Ids explícitos: una sola query inArray para todos los hints distintos.
  const hintSet = new Set<string>();
  for (const n of norms) if (n.hospitalIdHint) hintSet.add(n.hospitalIdHint);
  const existingIds = new Set<string>();
  if (hintSet.size > 0) {
    const found = await db
      .select({ id: hospitals.id })
      .from(hospitals)
      .where(inArray(hospitals.id, [...hintSet]));
    for (const r of found) existingIds.add(r.id);
  }

  // Clave canónica de nombre por fila (null si el id explícito ya resolvió o si no
  // hay texto de hospital). El alias curado se aplica antes de comparar.
  const canonicalByRow: (string | null)[] = norms.map((n) => {
    if (n.hospitalIdHint && existingIds.has(n.hospitalIdHint)) return null;
    const txt = n.sourceHospital.trim();
    if (!txt) return null;
    return resolveHospitalAlias(txt) ?? txt;
  });

  // 2) Nombres exactos case-insensitive: una sola query para todas las claves
  //    distintas. Se cuenta cuántos hospitales matchean cada clave para aplicar la
  //    regla de ambigüedad (count === 1 resuelve; 0 o ≥2 quedan sin resolver).
  const lowerKeys = new Set<string>();
  for (const c of canonicalByRow) if (c) lowerKeys.add(c.toLowerCase());
  const nameMatch = new Map<string, NameMatch>();
  if (lowerKeys.size > 0) {
    const matches = (await db
      .select({ id: hospitals.id, lname: sql<string>`lower(${hospitals.name})` })
      .from(hospitals)
      .where(inArray(sql`lower(${hospitals.name})`, [...lowerKeys]))) as {
      id: string;
      lname: string;
    }[];
    for (const m of matches) {
      const prev = nameMatch.get(m.lname);
      if (prev) prev.count++;
      else nameMatch.set(m.lname, { id: m.id, count: 1 });
    }
  }

  return norms.map((n, i) => {
    if (n.hospitalIdHint && existingIds.has(n.hospitalIdHint)) return n.hospitalIdHint;
    const canonical = canonicalByRow[i];
    if (!canonical) return null;
    const match = nameMatch.get(canonical.toLowerCase());
    return match && match.count === 1 ? match.id : null;
  });
}

/** Carga (cacheado) los candidatos de dedup de un hospital desde DB. */
async function loadHospitalCandidates(
  hospitalId: string,
  cache: Map<string, Map<string, DedupCandidate[]>>,
): Promise<Map<string, DedupCandidate[]>> {
  const cached = cache.get(hospitalId);
  if (cached) return cached;
  const db = getDb();
  // Documento por su columna dedicada (HMAC). NO se deriva de `notes` para evitar
  // leer la cédula cruda de pacientes existentes (B4/Q4).
  const patients = await db
    .select({
      id: hospitalPatients.id,
      name: hospitalPatients.name,
      age: hospitalPatients.age,
      documentHash: hospitalPatients.documentHash,
    })
    .from(hospitalPatients)
    .where(eq(hospitalPatients.hospitalId, hospitalId));
  const byKey = new Map<string, DedupCandidate[]>();
  for (const p of patients) {
    const key = nameKey(p.name);
    if (!key) continue;
    const cand: DedupCandidate = {
      patientId: p.id,
      name: p.name,
      age: p.age ?? null,
      documentHash: p.documentHash ?? null,
    };
    const list = byKey.get(key);
    if (list) list.push(cand);
    else byKey.set(key, [cand]);
  }
  cache.set(hospitalId, byKey);
  return byKey;
}

/**
 * Candidatos por DOCUMENTO exacto (HMAC), independientes del nombre. El bloqueo
 * por `nameKey` de `loadHospitalCandidates` jamás vería un paciente con el MISMO
 * documento pero distinto nombre; este lookup directo `(hospital_id,
 * document_hash)` cierra ese hueco (lo respalda el índice parcial
 * `idx_hospital_patients_document_hash`). Cacheado por `(hospital, hash)` para no
 * repetir la query dentro del lote.
 */
async function loadDocumentHashCandidates(
  hospitalId: string,
  documentHash: string,
  cache: Map<string, DedupCandidate[]>,
): Promise<DedupCandidate[]> {
  const key = `${hospitalId}::${documentHash}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const db = getDb();
  const patients = await db
    .select({
      id: hospitalPatients.id,
      name: hospitalPatients.name,
      age: hospitalPatients.age,
      documentHash: hospitalPatients.documentHash,
    })
    .from(hospitalPatients)
    .where(
      and(
        eq(hospitalPatients.hospitalId, hospitalId),
        eq(hospitalPatients.documentHash, documentHash),
      ),
    );
  const candidates: DedupCandidate[] = patients.map((p) => ({
    patientId: p.id,
    name: p.name,
    age: p.age ?? null,
    documentHash: p.documentHash ?? null,
  }));
  cache.set(key, candidates);
  return candidates;
}

/** Une listas de candidatos sin duplicar por `patientId` (mantiene el orden). */
function mergeCandidatesUnique(...lists: DedupCandidate[][]): DedupCandidate[] {
  const seen = new Set<string>();
  const out: DedupCandidate[] = [];
  for (const list of lists) {
    for (const cand of list) {
      if (seen.has(cand.patientId)) continue;
      seen.add(cand.patientId);
      out.push(cand);
    }
  }
  return out;
}

/**
 * Procesa un lote: normaliza/valida/deduplica cada fila y actualiza contadores.
 * Idempotente: re-correr re-evalúa el staging desde el crudo (no escribe
 * pacientes). Lo invoca el worker.
 */
export async function processImport(importId: string): Promise<ImportSummaryDTO> {
  const db = getDb();
  const claimed = await transitionImportStatus(
    importId,
    ["pending", "queued", "processed"],
    "processing",
    "procesar",
  );
  if (!claimed) return (await getImport(importId))!;

  // Origen OCR/ICR (imagen/PDF): el contentType del lote lo marca. Toda fila
  // extraída por OCR es ADVISORY — JAMÁS puede quedar "valid"/lista ni
  // auto-aplicarse aunque los campos parezcan completos (#151/#158). Más abajo
  // se fuerza needs_review y se anexa OCR_REVIEW_WARNING a cada fila del lote.
  const ocrHeader = await loadHeader(importId);
  const ocrReview = ocrHeader ? isOcrPendingContentType(ocrHeader.contentType) : false;

  const rawRows = (await db
    .select({
      id: patientImportRows.id,
      rowIndex: patientImportRows.rowIndex,
      rawData: patientImportRows.rawData,
    })
    .from(patientImportRows)
    .where(eq(patientImportRows.importId, importId))
    .orderBy(asc(patientImportRows.rowIndex))) as RawStagingRow[];

  const candidateCache = new Map<string, Map<string, DedupCandidate[]>>();
  const documentHashCache = new Map<string, DedupCandidate[]>();
  // Dedup INTRA-lote: la primera fila válida "gana"; las siguientes idénticas se
  // marcan duplicadas contra ella. Dos índices: por (hospital, clave de nombre) y
  // por (hospital, document_hash), para que un mismo documento con distinto nombre
  // dentro del lote también se detecte como duplicado fuerte.
  const seenByNameInBatch = new Map<string, DedupCandidate[]>();
  const seenByDocInBatch = new Map<string, DedupCandidate[]>();

  let valid = 0;
  let invalid = 0;
  let duplicate = 0;
  let review = 0;
  const now = Date.now();

  // C6: pre-normaliza TODO el lote una vez y deriva el HMAC del documento ANTES de
  // tocar dedup/persistencia (queda en staging y se copia al paciente final, así la
  // purga del crudo en C5 no pierde la dedup exacta por documento). Con el lote ya
  // normalizado, resuelve los hospitales en batch (2 queries) en vez de N+1 por fila.
  const norms = rawRows.map((raw) => {
    const norm = normalizeRow((raw.rawData ?? {}) as RawPatientRow);
    norm.documentHash = documentHashFor(norm.documentDigits);
    return norm;
  });
  const hospitalIds = await resolveHospitalIdsForBatch(norms);

  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i]!;
    const norm = norms[i]!;
    const hospitalId = hospitalIds[i] ?? null;
    const { errors, hospitalUnresolved } = validateRow(norm, hospitalId !== null);
    const warnings = [...norm.warnings];
    // Origen OCR/ICR: aviso de revisión obligatoria en TODA fila del lote, sea
    // cual sea su veredicto (deja la procedencia visible para el revisor).
    if (ocrReview) warnings.push(OCR_REVIEW_WARNING);

    let rowStatus: string;
    let dedupStatus = "pending";
    let confidence = 0;
    let candidates: DedupCandidate[] = [];

    if (errors.length > 0) {
      rowStatus = "invalid";
      invalid++;
    } else if (hospitalUnresolved) {
      // B2/Q3: hay texto/id de hospital pero no resolvió a uno único. NO se aplica
      // ni se descarta: queda para revisión manual con un aviso claro.
      rowStatus = "needs_review";
      dedupStatus = "needs_review";
      review++;
      warnings.push(
        "No se pudo resolver el hospital indicado a uno único; requiere revisión manual antes de aplicar.",
      );
    } else {
      // Candidatos: existentes en DB + ya vistos en este lote. Se cruzan DOS
      // señales independientes — por clave de nombre y por document_hash exacto —
      // para que un mismo documento con distinto nombre también se deduplique.
      const nameBatchKey = `${hospitalId}::${norm.normalizedKey}`;
      const docBatchKey = norm.documentHash ? `${hospitalId}::${norm.documentHash}` : null;

      const dbByName =
        norm.normalizedKey && hospitalId
          ? (await loadHospitalCandidates(hospitalId, candidateCache)).get(norm.normalizedKey) ?? []
          : [];
      const dbByDoc =
        norm.documentHash && hospitalId
          ? await loadDocumentHashCandidates(hospitalId, norm.documentHash, documentHashCache)
          : [];
      const batchByName = seenByNameInBatch.get(nameBatchKey) ?? [];
      const batchByDoc = docBatchKey ? seenByDocInBatch.get(docBatchKey) ?? [] : [];

      const candidatePool = mergeCandidatesUnique(dbByName, dbByDoc, batchByName, batchByDoc);
      const verdict = classifyDedup(norm, candidatePool);
      dedupStatus = verdict.status;
      confidence = verdict.confidence;
      candidates = verdict.candidates;

      if (verdict.status === "unique") {
        rowStatus = "valid";
        valid++;
        // Esta fila ahora es candidata para las siguientes del lote (por ambos índices).
        const self: DedupCandidate = {
          patientId: `row:${raw.id}`,
          name: norm.name,
          age: norm.age,
          documentHash: norm.documentHash,
        };
        if (batchByName.length) batchByName.push(self);
        else seenByNameInBatch.set(nameBatchKey, [self]);
        if (docBatchKey) {
          if (batchByDoc.length) batchByDoc.push(self);
          else seenByDocInBatch.set(docBatchKey, [self]);
        }
      } else if (verdict.status === "duplicate") {
        rowStatus = "duplicate";
        duplicate++;
      } else {
        rowStatus = "needs_review";
        review++;
      }
    }

    // INVARIANTE OCR/ICR: una fila extraída por OCR jamás queda "valid". El
    // tracking intra-lote de candidatos (arriba) ya consideró esta fila como
    // persona real, así que la dedup de las siguientes filas no se ve afectada;
    // aquí solo se rebaja el veredicto final a needs_review para que el apply
    // (que solo toma "valid") nunca la escriba sin revisión humana.
    if (ocrReview && rowStatus === "valid") {
      rowStatus = "needs_review";
      dedupStatus = "needs_review";
      valid--;
      review++;
    }

    await db
      .update(patientImportRows)
      .set({
        name: norm.name,
        normalizedKey: norm.normalizedKey,
        age: norm.age,
        condition: norm.condition,
        status: norm.status,
        sourceHospital: norm.sourceHospital,
        hospitalId,
        documentHash: norm.documentHash,
        validationErrors: errors,
        validationWarnings: warnings,
        dedupStatus,
        dedupCandidates: candidates,
        confidence,
        rowStatus,
        updatedAt: now,
      })
      .where(eq(patientImportRows.id, raw.id));
  }

  await db
    .update(patientImports)
    .set({
      status: "processed",
      validRows: valid,
      invalidRows: invalid,
      duplicateRows: duplicate,
      reviewRows: review,
      processedAt: now,
      updatedAt: now,
      errorSummary: null,
    })
    .where(eq(patientImports.id, importId));

  return (await getImport(importId))!;
}

// --------------------------------------------------------------------------
// Apply (lo corre el worker): escribe SOLO filas válidas y únicas. Idempotente.
// --------------------------------------------------------------------------

interface ApplyableRow {
  id: string;
  name: string;
  age: number | null;
  condition: string | null;
  status: string | null;
  hospitalId: string | null;
  documentHash: string | null;
}

function normalizePatientCondition(value: string | null): PatientCondition {
  return PATIENT_CONDITIONS.has(value ?? "")
    ? (value as PatientCondition)
    : PATIENT_CONDITION.UNKNOWN;
}

function normalizePatientStatus(value: string | null): PatientStatus {
  return PATIENT_STATUSES.has(value ?? "")
    ? (value as PatientStatus)
    : PATIENT_STATUS.HOSPITALIZED;
}

async function applyOneRowAtomically(rowId: string): Promise<string | null> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const locked = (await tx.execute(sql`
      select id, name, age, condition, status, hospital_id as "hospitalId",
             document_hash as "documentHash"
      from patient_import_rows
      where id = ${rowId}
        and row_status = 'valid'
        and patient_id is null
      for update
    `)) as unknown as QueryRows<ApplyableRow>;
    const row = locked.rows[0];
    if (!row?.hospitalId || !row.name) return null;

    const patientId = randomUUID();
    const now = Date.now();
    const name = row.name.trim().slice(0, 120);
    const age = row.age === null || row.age === undefined ? null : Math.max(0, Math.trunc(Number(row.age)));
    const condition = normalizePatientCondition(row.condition);
    const status = normalizePatientStatus(row.status);
    const documentHash = row.documentHash ?? null;

    await tx.execute(sql`
      insert into hospital_patients
        (id, hospital_id, name, age, condition, status, notes, contact, document_hash, admitted_at, updated_at)
      values
        (${patientId}, ${row.hospitalId}, ${name}, ${age}, ${condition}, ${status}, '', '', ${documentHash}, ${now}, ${now})
    `);
    await tx
      .update(patientImportRows)
      .set({ patientId, rowStatus: "applied", updatedAt: now })
      .where(eq(patientImportRows.id, row.id));
    return patientId;
  });
}

/**
 * Aplica las filas `valid` (únicas) que aún no tienen paciente. Idempotente:
 * solo toma filas con `patient_id IS NULL`, así re-correr no duplica. Las filas
 * inválidas/duplicadas/en revisión se OMITEN (nunca se auto-mergea un conflicto).
 */
export async function applyImport(
  importId: string,
  actorId: string | null,
): Promise<ImportSummaryDTO> {
  const db = getDb();
  const claimed = await db.transaction(async (tx) => {
    const header = await lockHeaderForUpdate(tx, importId);
    if (!header) throw new Error(`patient_import ${importId} no existe`);
    if (header.status === "applying") return false;
    assertImportState(header, ["processed", "applied", "failed"], "aplicar");
    if (header.status === "failed" && header.failedStage !== PATIENT_IMPORT_FAILED_STAGE.APPLY) {
      throw new Error('Solo se puede reanudar un lote fallido durante la etapa "apply".');
    }
    await tx
      .update(patientImports)
      .set({ status: "applying", failedStage: null, updatedAt: Date.now() })
      .where(eq(patientImports.id, importId));
    return true;
  });
  if (!claimed) return (await getImport(importId))!;

  const toApply = (await db
    .select({
      id: patientImportRows.id,
      name: patientImportRows.name,
      age: patientImportRows.age,
      condition: patientImportRows.condition,
      status: patientImportRows.status,
      hospitalId: patientImportRows.hospitalId,
    })
    .from(patientImportRows)
    .where(
      and(
        eq(patientImportRows.importId, importId),
        eq(patientImportRows.rowStatus, "valid"),
        isNull(patientImportRows.patientId),
      ),
    )) as ApplyableRow[];

  const now = Date.now();
  for (const row of toApply) {
    await applyOneRowAtomically(row.id);
  }

  // Recuenta aplicadas desde DB (refleja runs acumulados; idempotente).
  const appliedCount = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(patientImportRows)
    .where(
      and(eq(patientImportRows.importId, importId), eq(patientImportRows.rowStatus, "applied")),
    )) as { n: number }[];

  await db
    .update(patientImports)
    .set({
      status: "applied",
      appliedRows: appliedCount[0]?.n ?? 0,
      appliedAt: now,
      updatedAt: now,
    })
    .where(eq(patientImports.id, importId));

  void actorId; // la auditoría del apply la registra el route (tiene el req).
  return (await getImport(importId))!;
}

/** Marca el import como fallido con un resumen legible (sin PII ni stack). */
export async function markImportFailed(
  importId: string,
  summary: string,
  failedStage?: PatientImportFailedStage,
): Promise<void> {
  const db = getDb();
  await db
    .update(patientImports)
    .set({
      status: "failed",
      failedStage: failedStage ?? null,
      errorSummary: summary.slice(0, 500),
      updatedAt: Date.now(),
    })
    .where(eq(patientImports.id, importId));
}

/**
 * C5 (#151) — MECANISMO de purga del crudo sensible (`raw_data`: cédula/notas/
 * contacto), SIN política. La política (plazo, trigger, automatización) la decide
 * el equipo después; esta función no la baked-in:
 *
 *  - `olderThanMs` es un parámetro EXPLÍCITO (no hay default de plazo).
 *  - Dry-run por defecto: sin `confirm: true` NO borra nada, solo cuenta cuántas
 *    filas se purgarían (para medir el impacto antes de decidir).
 *  - Solo toca lotes ya `applied` (los pacientes finales ya se escribieron) y
 *    aplicados antes del corte; vacía `raw_data` a `{}` conservando la fila, sus
 *    campos derivados y `patient_id` (idempotencia del apply intacta).
 *  - No se conecta a ningún cron/endpoint automático: queda lista pero dormida.
 *
 * Invariante de derivados: `document_hash` (HMAC) se calcula y persiste en
 * `processImport` y se copia al paciente final en `applyImport`, ambos ANTES de
 * cualquier purga. Por eso vaciar `raw_data` aquí no pierde la capacidad de dedup
 * exacta por documento. Cualquier derivado nuevo del crudo debe seguir esta misma
 * regla: persistir antes de purgar.
 */
export async function purgeAppliedRawData(opts: {
  olderThanMs: number;
  confirm?: boolean;
}): Promise<{ matched: number; purged: number }> {
  if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) {
    throw new Error("purgeAppliedRawData: olderThanMs debe ser un número >= 0");
  }
  const db = getDb();
  const cutoff = Date.now() - opts.olderThanMs;

  // Subconjunto seguro: filas de lotes `applied` aplicados antes del corte cuyo
  // raw_data aún tiene contenido (evita recontar filas ya purgadas).
  const appliedOld = db
    .select({ id: patientImports.id })
    .from(patientImports)
    .where(and(eq(patientImports.status, "applied"), lt(patientImports.appliedAt, cutoff)));
  const targetWhere = and(
    inArray(patientImportRows.importId, appliedOld),
    sql`${patientImportRows.rawData} <> '{}'::jsonb`,
  );

  const counted = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(patientImportRows)
    .where(targetWhere)) as { n: number }[];
  const matched = counted[0]?.n ?? 0;

  if (!opts.confirm) return { matched, purged: 0 }; // dry-run: no borra nada

  await db
    .update(patientImportRows)
    .set({ rawData: {}, updatedAt: Date.now() })
    .where(targetWhere);
  return { matched, purged: matched };
}
