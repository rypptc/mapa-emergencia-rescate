/**
 * Integración — A1: apply atómico por fila e idempotente bajo jobs duplicados.
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import { randomUUID } from "crypto";

let svc: typeof import("@/services/patient-imports");
let db: typeof import("@/db");

beforeAll(async () => {
  svc = await import("@/services/patient-imports");
  db = await import("@/db");
});

describe("applyImport — atomicidad/idempotencia (A1)", () => {
  it("dos apply concurrentes no duplican el paciente final", async () => {
    const { eq } = await import("drizzle-orm");
    const hospitalId = randomUUID();
    const suffix = hospitalId.slice(0, 8);
    const hospitalName = `Hospital Atomic ${suffix}`;
    const patientName = `Paciente Atomic ${suffix}`;

    await db.getDb().insert(db.schema.hospitals).values({
      id: hospitalId,
      name: hospitalName,
      createdAt: Date.now(),
    });

    const created = await svc.createImport(
      { source: "atomic-test", rows: [{ name: patientName, hospital: hospitalName, age: 34 }] },
      null,
    );
    const processed = await svc.processImport(created.id);
    expect(processed.counts.valid).toBe(1);

    const results = await Promise.allSettled([
      svc.applyImport(created.id, null),
      svc.applyImport(created.id, null),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);

    const patients = await db
      .getDb()
      .select({ id: db.schema.hospitalPatients.id })
      .from(db.schema.hospitalPatients)
      .where(eq(db.schema.hospitalPatients.name, patientName));
    expect(patients).toHaveLength(1);

    const rows = await db
      .getDb()
      .select({ patientId: db.schema.patientImportRows.patientId })
      .from(db.schema.patientImportRows)
      .where(eq(db.schema.patientImportRows.importId, created.id));
    expect(rows[0]?.patientId).toBe(patients[0]?.id);
  });
});
