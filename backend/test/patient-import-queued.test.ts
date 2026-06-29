/**
 * Integración — D4: estado `queued` y manejo de lote huérfano en la creación.
 *
 * - markImportQueued avanza `pending → queued` y registra el jobId.
 * - markImportQueued NO pisa un estado más avanzado (carrera con un worker rápido
 *   que ya dejó el lote en `processing`).
 * - markImportFailed evita que un fallo de encolado deje el lote colgado en
 *   `pending` (queda `failed`, visible para la API).
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL.
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";

let svc: typeof import("@/services/patient-imports");
let db: typeof import("@/db");

beforeAll(async () => {
  svc = await import("@/services/patient-imports");
  db = await import("@/db");
});

async function newPending() {
  return svc.createImport(
    { source: "test", rows: [{ name: "Demo Anon", hospital: "Hospital Demo" }] },
    null,
  );
}

describe("createImport — estado queued y lote huérfano (D4)", () => {
  it("markImportQueued avanza pending→queued y registra el jobId", async () => {
    const imp = await newPending();
    expect(imp.status).toBe("pending");
    await svc.markImportQueued(imp.id, "job-d4-1");
    const after = await svc.getImport(imp.id);
    expect(after?.status).toBe("queued");
    expect(after?.jobId).toBe("job-d4-1");
  });

  it("markImportQueued NO pisa un estado avanzado (worker rápido)", async () => {
    const imp = await newPending();
    // Simula que el worker ya arrancó antes de que registremos el queued.
    const { eq } = await import("drizzle-orm");
    await db
      .getDb()
      .update(db.schema.patientImports)
      .set({ status: "processing" })
      .where(eq(db.schema.patientImports.id, imp.id));
    await svc.markImportQueued(imp.id, "job-d4-2");
    const after = await svc.getImport(imp.id);
    expect(after?.status).toBe("processing"); // no retrocede a queued
    expect(after?.jobId).toBe("job-d4-2"); // pero el jobId sí se registra
  });

  it("markImportFailed evita lote huérfano (no queda pending)", async () => {
    const imp = await newPending();
    await svc.markImportFailed(imp.id, "No se pudo encolar el procesamiento.");
    const after = await svc.getImport(imp.id);
    expect(after?.status).toBe("failed");
    expect(after?.errorSummary).toContain("No se pudo encolar");
  });
});
