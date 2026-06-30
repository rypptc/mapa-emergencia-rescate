/**
 * Integración — P0: applyImport REANUDA desde `applying`.
 *
 * Escenario: un intento de apply murió a mitad → el lote quedó en `applying` con
 * una fila ya aplicada y otra pendiente. El retry (worker) debe RETOMAR: aplicar
 * la pendiente, NO duplicar la ya aplicada, y dejar el lote `applied`.
 *
 * Antes del fix, applyImport veía `applying` y salía sin hacer nada (lote
 * atascado, parcial). Requiere el stack local arriba (DATABASE_URL).
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import { randomUUID } from "crypto";

let svc: typeof import("@/services/patient-imports");
let dbmod: typeof import("@/db");

beforeAll(async () => {
  svc = await import("@/services/patient-imports");
  dbmod = await import("@/db");
});

describe("applyImport — reanuda desde applying (P0)", () => {
  it("aplica las filas pendientes y no duplica las ya aplicadas", async () => {
    const { eq, sql } = await import("drizzle-orm");
    const db = dbmod.getDb();
    const schema = dbmod.schema;

    const hospitalId = randomUUID();
    const hospitalName = `Hospital Resume ${hospitalId.slice(0, 8)}`;
    await db.insert(schema.hospitals).values({
      id: hospitalId,
      name: hospitalName,
      createdAt: Date.now(),
    });

    const tag = hospitalId.slice(0, 8);
    const imp = await svc.createImport(
      {
        source: "test",
        rows: [
          { name: `Uno ${tag}`, hospital: hospitalName },
          { name: `Dos ${tag}`, hospital: hospitalName },
        ],
      },
      null,
    );
    await svc.processImport(imp.id);
    const rows = await svc.listImportRows(imp.id);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.rowStatus === "valid")).toBe(true);

    // Simula crash a mitad de apply: la fila 0 YA aplicada (paciente insertado +
    // fila marcada), la fila 1 pendiente, y el lote atascado en `applying`.
    const now = Date.now();
    const prePatientId = randomUUID();
    await db.execute(sql`
      insert into hospital_patients
        (id, hospital_id, name, age, condition, status, notes, contact, admitted_at, updated_at)
      values
        (${prePatientId}, ${hospitalId}, ${rows[0]!.name}, null, 'unknown', 'hospitalized', '', '', ${now}, ${now})
    `);
    await db
      .update(schema.patientImportRows)
      .set({ patientId: prePatientId, rowStatus: "applied", updatedAt: now })
      .where(eq(schema.patientImportRows.id, rows[0]!.id));
    await db
      .update(schema.patientImports)
      .set({ status: "applying", updatedAt: now })
      .where(eq(schema.patientImports.id, imp.id));

    const countPatients = async () => {
      const r = (await db.execute(
        sql`select count(*)::int as n from hospital_patients where hospital_id = ${hospitalId}`,
      )) as unknown as { rows: { n: number }[] };
      return r.rows[0]!.n;
    };
    expect(await countPatients()).toBe(1); // solo el pre-aplicado

    // RETOMA: antes del fix esto era no-op (salía por estado "applying").
    const summary = await svc.applyImport(imp.id, null);

    expect(await countPatients()).toBe(2); // aplicó la pendiente; NO duplicó la otra
    expect(summary.status).toBe("applied");
    const after = await svc.listImportRows(imp.id);
    expect(after.every((r) => r.rowStatus === "applied")).toBe(true);
  });
});
