/**
 * Cola `patient-imports` (lado WORKER) — procesa los lotes de importación de
 * pacientes hospitalarios (#151) fuera del request path (audit M-2). Mismo
 * patrón boahaus que maintenance.queue.ts: factory de worker ligero + lógica
 * pesada lazy-import.
 *
 * El PRODUCTOR vive en el backend (src/lib/queues.ts: enqueuePatientImport);
 * aquí solo consumimos. El payload del job es minúsculo (importId + modo): las
 * filas viven en la DB de staging, no en el job.
 *
 * Modos:
 *   - process: normaliza, valida y deduplica el staging del lote.
 *   - apply:   escribe las filas válidas y únicas en hospital_patients (idempotente).
 */
import { Worker, type Processor } from "bullmq";
import { getRedis } from "./redis";

const PREFIX = process.env.QUEUE_PREFIX || "mapa";
export const PATIENT_IMPORTS_QUEUE = "patient-imports";

type PatientImportMode = "process" | "apply";

interface PatientImportJobData {
  importId: string;
  mode: PatientImportMode;
  actorId?: string | null;
}

const processor: Processor = async (job) => {
  const data = job.data as PatientImportJobData;
  // Import relativo a src/ (mismo patrón que worker/sync/dedup.ts) para no
  // depender del resolutor de alias "@/" en el entrypoint del worker.
  const { processImport, applyImport, markImportFailed } = await import(
    "../src/services/patient-imports"
  );
  try {
    if (data.mode === "process") {
      const r = await processImport(data.importId);
      return { mode: "process", importId: data.importId, counts: r.counts };
    }
    if (data.mode === "apply") {
      const r = await applyImport(data.importId, data.actorId ?? null);
      return { mode: "apply", importId: data.importId, counts: r.counts };
    }
    throw new Error(`patient-import modo desconocido: ${(data as { mode: string }).mode}`);
  } catch (err) {
    // En el último intento, sella el lote como fallido con un resumen legible
    // (sin stack ni PII) para que la API lo refleje. BullMQ reintenta antes.
    const attemptsMade = job.attemptsMade + 1;
    const maxAttempts = job.opts.attempts ?? 1;
    if (attemptsMade >= maxAttempts) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      await markImportFailed(data.importId, `Falló el ${data.mode}: ${msg}`, data.mode).catch(
        () => {},
      );
    }
    throw err;
  }
};

export function createPatientImportsWorker(): Worker {
  const concurrency = Number(process.env.PATIENT_IMPORTS_CONCURRENCY || 2);
  // Un lote grande puede tardar; lock > job más largo para que no se marque
  // "stalled" y se re-ejecute en paralelo (mismo criterio que maintenance).
  const lockDuration = Number(process.env.LONG_JOB_LOCK_MS || 300_000);
  return new Worker(PATIENT_IMPORTS_QUEUE, processor, {
    connection: getRedis(),
    prefix: PREFIX,
    concurrency,
    lockDuration,
  });
}
