/**
 * Integración — B3/D7: transiciones protegidas por estado y reanudación acotada.
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";

let svc: typeof import("@/services/patient-imports");
let db: typeof import("@/db");

beforeAll(async () => {
  svc = await import("@/services/patient-imports");
  db = await import("@/db");
});

async function createPendingImport() {
  return svc.createImport(
    { source: "transition-test", rows: [{ name: "Demo Anon", hospital: "Hospital Demo" }] },
    null,
  );
}

async function setImportStatus(id: string, status: string, failedStage: string | null = null) {
  const { eq } = await import("drizzle-orm");
  await db
    .getDb()
    .update(db.schema.patientImports)
    .set({ status, failedStage, updatedAt: Date.now() })
    .where(eq(db.schema.patientImports.id, id));
}

describe("patient imports — máquina de estados (B3/D7)", () => {
  it("no aplica un lote no procesado", async () => {
    const imp = await createPendingImport();
    await expect(svc.applyImport(imp.id, null)).rejects.toThrow(/estado "pending"/);
  });

  it("no reprocesa un lote ya aplicado", async () => {
    const imp = await createPendingImport();
    await setImportStatus(imp.id, "applied");
    await expect(svc.processImport(imp.id)).rejects.toThrow(/estado "applied"/);
  });

  it("permite reanudar solo failed de etapa apply", async () => {
    const applyFailed = await createPendingImport();
    await setImportStatus(applyFailed.id, "failed", "apply");
    await expect(svc.applyImport(applyFailed.id, null)).resolves.toMatchObject({
      status: "applied",
    });

    const processFailed = await createPendingImport();
    await setImportStatus(processFailed.id, "failed", "process");
    await expect(svc.applyImport(processFailed.id, null)).rejects.toThrow(/fallido durante la etapa "apply"/);
  });
});
