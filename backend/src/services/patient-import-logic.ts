/**
 * Lógica PURA de importación de pacientes (#151) — sin DB, 100% testeable.
 *
 * Normalización, validación y CLASIFICACIÓN de deduplicación viven aquí como
 * funciones puras. La orquestación con DB (leer hospitales, buscar candidatos,
 * escribir filas) vive en `patient-imports.ts`. Separar permite probar el
 * comportamiento (qué es duplicado, qué necesita revisión, cómo se mapea un
 * estado en español) sin levantar Postgres.
 */

import { createHmac } from "crypto";

import type { PatientCondition, PatientStatus } from "@/services/patients";

/** Fila CRUDA de entrada (fase 1: JSON estructurado). Campos abiertos + extras. */
export interface RawPatientRow {
  /** Texto del hospital tal como vino (para resolverlo contra `hospitals`). */
  hospital?: string;
  /** Id de hospital explícito (si la integración ya lo conoce). */
  hospitalId?: string;
  name?: string;
  age?: number | string | null;
  condition?: string;
  status?: string;
  /** Documento/cédula — SENSIBLE: se queda en staging restringido, no público. */
  documentId?: string;
  notes?: string;
  contact?: string;
  [extra: string]: unknown;
}

/** Resultado de normalizar una fila cruda (antes de resolver hospital en DB). */
export interface NormalizedRow {
  name: string;
  normalizedKey: string;
  age: number | null;
  condition: PatientCondition;
  status: PatientStatus;
  sourceHospital: string;
  /** Id de hospital explícito de entrada (sin validar contra DB todavía). */
  hospitalIdHint: string | null;
  /** Solo dígitos del documento (para match exacto). null si no hubo. */
  documentDigits: string | null;
  /** HMAC del documento/cédula normalizado. null si no hubo documento útil. */
  documentHash: string | null;
  notes: string;
  contact: string;
  warnings: string[];
}

const CONDITIONS: ReadonlySet<PatientCondition> = new Set([
  "stable",
  "serious",
  "critical",
  "recovering",
  "unknown",
]);
const STATUSES: ReadonlySet<PatientStatus> = new Set([
  "hospitalized",
  "discharged",
  "transferred",
  "deceased",
]);

// Sinónimos comunes (ES/EN) → valor canónico. Conservador: lo no mapeado cae a
// un default seguro + un aviso (warning), nunca un error que descarte la fila.
const CONDITION_SYNONYMS: Record<string, PatientCondition> = {
  estable: "stable",
  stable: "stable",
  grave: "serious",
  serio: "serious",
  serious: "serious",
  critico: "critical",
  critical: "critical",
  "en recuperacion": "recovering",
  recuperandose: "recovering",
  recovering: "recovering",
  desconocido: "unknown",
  unknown: "unknown",
};
const STATUS_SYNONYMS: Record<string, PatientStatus> = {
  hospitalizado: "hospitalized",
  ingresado: "hospitalized",
  internado: "hospitalized",
  hospitalized: "hospitalized",
  alta: "discharged",
  "dado de alta": "discharged",
  egresado: "discharged",
  discharged: "discharged",
  trasladado: "transferred",
  transferido: "transferred",
  transferred: "transferred",
  fallecido: "deceased",
  muerto: "deceased",
  deceased: "deceased",
};

/** Quita acentos comunes del español (misma tabla translate que el dedup actual). */
function stripAccents(s: string): string {
  const from = "áéíóúüñÁÉÍÓÚÜÑ";
  const to = "aeiouunAEIOUUN";
  let out = "";
  for (const ch of s) {
    const i = from.indexOf(ch);
    out += i === -1 ? ch : to[i];
  }
  return out;
}

/** Nombre normalizado: trim + colapso de espacios + cota de longitud. */
export function normalizeName(raw: string | undefined | null): string {
  return (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Clave de bloqueo para dedup: minúsculas, sin acentos, solo alfanumérico y
 * espacios colapsados. "José  Pérez!" → "jose perez". Vacía si no hay nombre.
 */
export function nameKey(raw: string | undefined | null): string {
  const base = stripAccents((raw ?? "").toLowerCase());
  return base
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Edad: entero acotado 0..150. null si ausente/no parseable. */
export function normalizeAge(raw: number | string | null | undefined): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < 0 || i > 150) return null;
  return i;
}

/** Solo dígitos de un documento; null si quedan menos de 4 (señal inservible). */
export function documentDigits(raw: string | undefined | null): string | null {
  const d = (raw ?? "").replace(/[^0-9]/g, "");
  return d.length >= 4 ? d : null;
}

/**
 * HMAC-SHA256 del documento (solo dígitos) con el secreto de servidor. Pura dado
 * (digits, secret): permite dedup exacta por documento SIN guardar la cédula
 * cruda fuera del staging restringido. El secreto NO viaja en el dato derivado.
 */
export function hashDocumentDigits(digits: string, secret: string): string {
  return createHmac("sha256", secret).update(digits).digest("hex");
}

/**
 * Clave normalizada de hospital para alias/resolución: minúsculas, sin acentos,
 * solo alfanumérico y espacios colapsados. "Hosp. Central" → "hosp central".
 */
export function hospitalNameKey(raw: string | undefined | null): string {
  const base = stripAccents((raw ?? "").toLowerCase());
  return base
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Alias curados de hospital (clave normalizada → nombre canónico tal como vive en
 * `hospitals.name`). MÍNIMO y explícito: el equipo agrega entradas verificadas;
 * NO se inventan nombres reales aquí. Vacío hoy = sin reescritura (la resolución
 * cae al match exacto por nombre). Mantener determinista y testeable.
 */
export const HOSPITAL_ALIASES: Readonly<Record<string, string>> = Object.freeze({});

/** Devuelve el nombre canónico si el texto coincide con un alias curado; si no, null. */
export function resolveHospitalAlias(raw: string | undefined | null): string | null {
  const key = hospitalNameKey(raw);
  if (!key) return null;
  return HOSPITAL_ALIASES[key] ?? null;
}

/** Mapea condición de entrada a enum; default "unknown" + aviso si no se reconoce. */
export function mapCondition(raw: string | undefined): {
  value: PatientCondition;
  warning?: string;
} {
  if (raw === undefined || raw.trim() === "") return { value: "unknown" };
  const key = stripAccents(raw.toLowerCase().trim());
  if (CONDITIONS.has(key as PatientCondition)) return { value: key as PatientCondition };
  const mapped = CONDITION_SYNONYMS[key];
  if (mapped) return { value: mapped };
  return { value: "unknown", warning: `Condición no reconocida ("${raw}"), se usó "unknown".` };
}

/** Mapea estado de entrada a enum; default "hospitalized" + aviso si no se reconoce. */
export function mapStatus(raw: string | undefined): {
  value: PatientStatus;
  warning?: string;
} {
  if (raw === undefined || raw.trim() === "") return { value: "hospitalized" };
  const key = stripAccents(raw.toLowerCase().trim());
  if (STATUSES.has(key as PatientStatus)) return { value: key as PatientStatus };
  const mapped = STATUS_SYNONYMS[key];
  if (mapped) return { value: mapped };
  return {
    value: "hospitalized",
    warning: `Estado no reconocido ("${raw}"), se usó "hospitalized".`,
  };
}

/** Normaliza una fila cruda a la forma staging (sin tocar DB). */
export function normalizeRow(raw: RawPatientRow): NormalizedRow {
  const warnings: string[] = [];
  const name = normalizeName(raw.name);
  const condition = mapCondition(raw.condition);
  if (condition.warning) warnings.push(condition.warning);
  const status = mapStatus(raw.status);
  if (status.warning) warnings.push(status.warning);

  return {
    name,
    normalizedKey: nameKey(name),
    age: normalizeAge(raw.age),
    condition: condition.value,
    status: status.value,
    sourceHospital: (raw.hospital ?? "").trim().slice(0, 200),
    hospitalIdHint: raw.hospitalId?.trim() ? raw.hospitalId.trim().slice(0, 120) : null,
    documentDigits: documentDigits(raw.documentId),
    documentHash: null,
    notes: (raw.notes ?? "").trim().slice(0, 600),
    contact: (raw.contact ?? "").trim().slice(0, 120),
    warnings,
  };
}

/**
 * Valida la identidad mínima de una fila normalizada DESPUÉS de intentar
 * resolver el hospital. `hospitalResolved` = true si el orquestador encontró el
 * hospital.
 *
 * Distingue dos fallos de hospital (B2/Q3):
 *   - SIN texto ni id de hospital  → `errors` (rowStatus "invalid": no hay nada
 *     que resolver, dato incompleto de origen).
 *   - CON texto/id pero no resuelto → `hospitalUnresolved` (rowStatus
 *     "needs_review": hay una pista válida, requiere desambiguación manual; NO se
 *     descarta ni se aplica, no se pierde).
 *
 * Un `errors` no vacío => la fila NO es aplicable (rowStatus "invalid").
 */
export function validateRow(
  row: NormalizedRow,
  hospitalResolved: boolean,
): { errors: string[]; hospitalUnresolved: boolean } {
  const errors: string[] = [];
  if (!row.name) errors.push("Falta el nombre del paciente.");
  const hasHospitalInput = Boolean(row.sourceHospital || row.hospitalIdHint);
  if (!hasHospitalInput) {
    errors.push("Falta el hospital (texto o id resoluble).");
  }
  return { errors, hospitalUnresolved: hasHospitalInput && !hospitalResolved };
}

/** Candidato de duplicado contra un paciente ya existente (o de este mismo lote). */
export interface DedupCandidate {
  patientId: string;
  name: string;
  age: number | null;
  /** HMAC del documento/cédula normalizado (si hubo). */
  documentHash: string | null;
  reason?: string;
}

export type DedupStatus = "unique" | "duplicate" | "needs_review";

export interface DedupVerdict {
  status: DedupStatus;
  confidence: number;
  /** Candidatos relevantes (allowlist) que respaldan el veredicto. */
  candidates: DedupCandidate[];
}

/** ¿Ambas edades son conocidas e iguales? */
function sameKnownAge(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && a === b;
}

/**
 * Clasifica una fila contra sus candidatos (mismo hospital + misma clave de
 * nombre). Política conservadora (primera versión, sin trigram):
 *   - document_hash EXACTO compartido  → duplicate (confidence 1.0)
 *   - nombre+edad conocida igual       → duplicate (confidence 0.9)
 *   - nombre igual, edad desconocida   → needs_review (confidence 0.6)
 *   - nombre igual, edad incompatible  → needs_review (confidence 0.5)
 *   - sin candidatos                   → unique (confidence 0.0)
 * NUNCA auto-mergea: "duplicate"/"needs_review" se OMITEN en el apply.
 * TODO(#151): ampliar con similitud trigram (pg_trgm/unaccent) para nombres
 * cercanos pero no idénticos.
 */
export function classifyDedup(
  row: NormalizedRow,
  candidates: DedupCandidate[],
): DedupVerdict {
  if (candidates.length === 0) {
    return { status: "unique", confidence: 0, candidates: [] };
  }

  // 1) Match exacto por documento (la señal más fuerte).
  if (row.documentHash) {
    const docMatch = candidates.filter((c) => c.documentHash === row.documentHash);
    if (docMatch.length > 0) {
      return {
        status: "duplicate",
        confidence: 1,
        candidates: docMatch.map((c) => ({ ...c, reason: "document_hash exacto" })),
      };
    }
  }

  // 2) Mismo nombre normalizado (los candidatos ya vienen filtrados por clave).
  const sameAge = candidates.filter((c) => sameKnownAge(row.age, c.age));
  if (sameAge.length > 0) {
    return {
      status: "duplicate",
      confidence: 0.9,
      candidates: sameAge.map((c) => ({ ...c, reason: "nombre y edad conocida igual" })),
    };
  }

  const unknownAge = candidates.filter((c) => row.age === null || c.age === null);
  if (unknownAge.length > 0) {
    return {
      status: "needs_review",
      confidence: 0.6,
      candidates: unknownAge.map((c) => ({ ...c, reason: "mismo nombre, edad desconocida" })),
    };
  }

  // 3) Mismo nombre pero edad incompatible → revisión manual (posible homónimo).
  return {
    status: "needs_review",
    confidence: 0.5,
    candidates: candidates.map((c) => ({ ...c, reason: "mismo nombre, edad distinta" })),
  };
}
