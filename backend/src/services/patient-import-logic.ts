/**
 * Lógica PURA de importación de pacientes (#151) — sin DB, 100% testeable.
 *
 * Normalización, validación y CLASIFICACIÓN de deduplicación viven aquí como
 * funciones puras. La orquestación con DB (leer hospitales, buscar candidatos,
 * escribir filas) vive en `patient-imports.ts`. Separar permite probar el
 * comportamiento (qué es duplicado, qué necesita revisión, cómo se mapea un
 * estado en español) sin levantar Postgres.
 */

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
    notes: (raw.notes ?? "").trim().slice(0, 600),
    contact: (raw.contact ?? "").trim().slice(0, 120),
    warnings,
  };
}

/**
 * Valida la identidad mínima de una fila normalizada DESPUÉS de intentar
 * resolver el hospital. `hospitalResolved` = true si el orquestador encontró el
 * hospital. Un error => la fila NO es aplicable (rowStatus "invalid").
 */
export function validateRow(
  row: NormalizedRow,
  hospitalResolved: boolean,
): { errors: string[] } {
  const errors: string[] = [];
  if (!row.name) errors.push("Falta el nombre del paciente.");
  if (!hospitalResolved) {
    errors.push(
      row.sourceHospital || row.hospitalIdHint
        ? "No se pudo resolver el hospital indicado."
        : "Falta el hospital (texto o id resoluble).",
    );
  }
  return { errors };
}

/** Candidato de duplicado contra un paciente ya existente (o de este mismo lote). */
export interface DedupCandidate {
  patientId: string;
  name: string;
  age: number | null;
  /** Dígitos de documento detectados en las notas del candidato (si hubo). */
  documentDigits: string | null;
  reason?: string;
}

export type DedupStatus = "unique" | "duplicate" | "needs_review";

export interface DedupVerdict {
  status: DedupStatus;
  confidence: number;
  /** Candidatos relevantes (allowlist) que respaldan el veredicto. */
  candidates: DedupCandidate[];
}

/** ¿Las edades son compatibles? (iguales, o al menos una desconocida). */
function ageCompatible(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return true;
  return a === b;
}

/**
 * Clasifica una fila contra sus candidatos (mismo hospital + misma clave de
 * nombre). Política conservadora (primera versión, sin trigram):
 *   - documento EXACTO compartido      → duplicate (confidence 1.0)
 *   - nombre+edad compatibles          → duplicate (confidence 0.9)
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
  if (row.documentDigits) {
    const docMatch = candidates.filter((c) => c.documentDigits === row.documentDigits);
    if (docMatch.length > 0) {
      return {
        status: "duplicate",
        confidence: 1,
        candidates: docMatch.map((c) => ({ ...c, reason: "documento exacto" })),
      };
    }
  }

  // 2) Mismo nombre normalizado (los candidatos ya vienen filtrados por clave).
  const ageOk = candidates.filter((c) => ageCompatible(row.age, c.age));
  if (ageOk.length > 0) {
    return {
      status: "duplicate",
      confidence: 0.9,
      candidates: ageOk.map((c) => ({ ...c, reason: "nombre y edad compatibles" })),
    };
  }

  // 3) Mismo nombre pero edad incompatible → revisión manual (posible homónimo).
  return {
    status: "needs_review",
    confidence: 0.5,
    candidates: candidates.map((c) => ({ ...c, reason: "mismo nombre, edad distinta" })),
  };
}
