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

import { randomUUID } from "crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  createPatient,
  type PatientCondition,
  type PatientStatus,
} from "@/services/patients";
import {
  classifyDedup,
  documentDigits,
  nameKey,
  normalizeRow,
  validateRow,
  type DedupCandidate,
  type RawPatientRow,
} from "@/services/patient-import-logic";

const { patientImports, patientImportRows, hospitalPatients, hospitals } = schema;

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
  rows: RawPatientRow[];
}

interface ImportHeaderRow {
  id: string;
  status: string;
  source: string;
  contentType: string;
  jobId: string | null;
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

/**
 * Crea un lote en STAGING (cabecera + filas crudas) en estado `pending`. NO
 * procesa nada inline (el worker lo hace): devuelve la cabecera para que la API
 * responda 202 con el id a consultar.
 */
export async function createImport(
  input: CreateImportInput,
  actorId: string | null,
): Promise<ImportSummaryDTO> {
  const db = getDb();
  const now = Date.now();
  const id = randomUUID();

  await db.insert(patientImports).values({
    id,
    status: "pending",
    source: (input.source ?? "api").slice(0, 120),
    contentType: (input.contentType ?? "application/json").slice(0, 120),
    totalRows: input.rows.length,
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });

  if (input.rows.length > 0) {
    await db.insert(patientImportRows).values(
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

  const header = await loadHeader(id);
  return toSummary(header!);
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
// Procesado (lo corre el worker): normaliza, valida, deduplica, actualiza.
// --------------------------------------------------------------------------

interface RawStagingRow {
  id: string;
  rowIndex: number;
  rawData: unknown;
}

/** Resuelve un hospital por id explícito o por nombre exacto (case-insensitive). */
async function resolveHospitalId(
  hint: string | null,
  sourceHospital: string,
): Promise<string | null> {
  const db = getDb();
  if (hint) {
    const byId = await db
      .select({ id: hospitals.id })
      .from(hospitals)
      .where(eq(hospitals.id, hint))
      .limit(1);
    if (byId[0]) return byId[0].id;
  }
  const txt = sourceHospital.trim();
  if (!txt) return null;
  // Nombre exacto case-insensitive. Si hay ambigüedad (≥2) NO resolvemos: que el
  // operador desambigüe con el id explícito (evita asignar al hospital equivocado).
  const byName = await db
    .select({ id: hospitals.id })
    .from(hospitals)
    .where(sql`lower(${hospitals.name}) = lower(${txt})`)
    .limit(2);
  return byName.length === 1 ? (byName[0]?.id ?? null) : null;
}

/** Carga (cacheado) los candidatos de dedup de un hospital desde DB. */
async function loadHospitalCandidates(
  hospitalId: string,
  cache: Map<string, Map<string, DedupCandidate[]>>,
): Promise<Map<string, DedupCandidate[]>> {
  const cached = cache.get(hospitalId);
  if (cached) return cached;
  const db = getDb();
  const patients = await db
    .select({
      id: hospitalPatients.id,
      name: hospitalPatients.name,
      age: hospitalPatients.age,
      notes: hospitalPatients.notes,
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
      documentDigits: documentDigits(p.notes),
    };
    const list = byKey.get(key);
    if (list) list.push(cand);
    else byKey.set(key, [cand]);
  }
  cache.set(hospitalId, byKey);
  return byKey;
}

/**
 * Procesa un lote: normaliza/valida/deduplica cada fila y actualiza contadores.
 * Idempotente: re-correr re-evalúa el staging desde el crudo (no escribe
 * pacientes). Lo invoca el worker.
 */
export async function processImport(importId: string): Promise<ImportSummaryDTO> {
  const db = getDb();
  const header = await loadHeader(importId);
  if (!header) throw new Error(`patient_import ${importId} no existe`);

  await db
    .update(patientImports)
    .set({ status: "processing", updatedAt: Date.now() })
    .where(eq(patientImports.id, importId));

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
  // Dedup INTRA-lote: la primera fila válida de una (hospital, clave) "gana"; las
  // siguientes idénticas se marcan duplicadas contra ella.
  const seenInBatch = new Map<string, DedupCandidate[]>();

  let valid = 0;
  let invalid = 0;
  let duplicate = 0;
  let review = 0;
  const now = Date.now();

  for (const raw of rawRows) {
    const norm = normalizeRow((raw.rawData ?? {}) as RawPatientRow);
    const hospitalId = await resolveHospitalId(norm.hospitalIdHint, norm.sourceHospital);
    const { errors } = validateRow(norm, hospitalId !== null);

    let rowStatus: string;
    let dedupStatus = "pending";
    let confidence = 0;
    let candidates: DedupCandidate[] = [];

    if (errors.length > 0) {
      rowStatus = "invalid";
      invalid++;
    } else {
      // Candidatos: existentes en DB + ya vistos en este lote (mismo hospital+clave).
      const batchKey = `${hospitalId}::${norm.normalizedKey}`;
      const dbCandidates =
        norm.normalizedKey && hospitalId
          ? (await loadHospitalCandidates(hospitalId, candidateCache)).get(norm.normalizedKey) ?? []
          : [];
      const batchCandidates = seenInBatch.get(batchKey) ?? [];
      const verdict = classifyDedup(norm, [...dbCandidates, ...batchCandidates]);
      dedupStatus = verdict.status;
      confidence = verdict.confidence;
      candidates = verdict.candidates;

      if (verdict.status === "unique") {
        rowStatus = "valid";
        valid++;
        // Esta fila ahora es candidata para las siguientes del lote.
        const self: DedupCandidate = {
          patientId: `row:${raw.id}`,
          name: norm.name,
          age: norm.age,
          documentDigits: norm.documentDigits,
        };
        if (batchCandidates.length) batchCandidates.push(self);
        else seenInBatch.set(batchKey, [self]);
      } else if (verdict.status === "duplicate") {
        rowStatus = "duplicate";
        duplicate++;
      } else {
        rowStatus = "needs_review";
        review++;
      }
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
        validationErrors: errors,
        validationWarnings: norm.warnings,
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
  const header = await loadHeader(importId);
  if (!header) throw new Error(`patient_import ${importId} no existe`);

  await db
    .update(patientImports)
    .set({ status: "applying", updatedAt: Date.now() })
    .where(eq(patientImports.id, importId));

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
    if (!row.hospitalId || !row.name) continue; // defensivo (no debería pasar en "valid")
    const created = await createPatient({
      hospitalId: row.hospitalId,
      name: row.name,
      age: row.age,
      // El staging ya guardó valores canónicos del enum; createPatient los
      // revalida igual (PATIENT_CONDITIONS/STATUSES.has) antes de escribir.
      condition: (row.condition ?? undefined) as PatientCondition | undefined,
      status: (row.status ?? undefined) as PatientStatus | undefined,
      // A0 (privacidad) — MITIGACIÓN TEMPORAL, ver #117.
      // El campo `notes` se expone hoy en la búsqueda pública de pacientes
      // (publicSafe solo restringe el WHERE, no el DTO), así que una cédula o
      // nota médica del input quedaría pública. Por eso la importación NO propaga
      // notas crudas al paciente final. El crudo sigue confinado en `raw_data`
      // (staging restringido).
      // El fix de raíz es #117 (que el DTO público de pacientes no devuelva
      // `notes` + guardrail), igual que `public_hospitalized_patients` en #71 de
      // venezuela-ayuda. Cuando #117 aterrice, decidir si los pacientes
      // importados conservan notas en un campo restringido en vez de vaciarlas.
      notes: "",
    });
    await db
      .update(patientImportRows)
      .set({ patientId: created.id, rowStatus: "applied", updatedAt: now })
      .where(eq(patientImportRows.id, row.id));
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
export async function markImportFailed(importId: string, summary: string): Promise<void> {
  const db = getDb();
  await db
    .update(patientImports)
    .set({ status: "failed", errorSummary: summary.slice(0, 500), updatedAt: Date.now() })
    .where(eq(patientImports.id, importId));
}
