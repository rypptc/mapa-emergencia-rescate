/**
 * Integración — C5: MECANISMO de purga del crudo sensible (`raw_data`), sin
 * política. Verifica que:
 *  - dry-run (sin confirm) cuenta pero NO borra,
 *  - confirm vacía `raw_data` SOLO de lotes `applied` (anteriores al corte),
 *  - la fila y su `patient_id` se conservan (idempotencia del apply intacta),
 *  - un lote NO aplicado (pending) no se toca.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL.
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

describe("purgeAppliedRawData — C5 (mecanismo, sin política)", () => {
  it("dry-run no borra; confirm purga solo applied y preserva fila; no toca pending", async () => {
    const { eq } = await import("drizzle-orm");
    const conn = db.getDb();
    const schema = db.schema;

    // Lote APLICADO con crudo sensible sintético.
    const hospitalId = randomUUID();
    const hospitalName = `Hospital Purge ${hospitalId.slice(0, 8)}`;
    await conn.insert(schema.hospitals).values({
      id: hospitalId,
      name: hospitalName,
      createdAt: Date.now(),
    });
    const applied = await svc.createImport(
      {
        source: "test",
        rows: [{ name: `Pac ${hospitalId.slice(0, 8)}`, hospital: hospitalName, notes: "dato sensible demo" }],
      },
      null,
    );
    await svc.processImport(applied.id);
    await svc.applyImport(applied.id, null);
    // Backdate del appliedAt para un corte determinístico.
    await conn
      .update(schema.patientImports)
      .set({ appliedAt: Date.now() - 60_000 })
      .where(eq(schema.patientImports.id, applied.id));

    // Lote PENDING (no aplicado) — no debe tocarse nunca.
    const pending = await svc.createImport(
      { source: "test", rows: [{ name: "Pendiente Demo", hospital: "Sin Resolver" }] },
      null,
    );

    const rowOf = async (importId: string) => {
      const r = await conn
        .select({ raw: schema.patientImportRows.rawData, pid: schema.patientImportRows.patientId })
        .from(schema.patientImportRows)
        .where(eq(schema.patientImportRows.importId, importId));
      return r[0];
    };

    // Dry-run: cuenta >= 1, no borra.
    const dry = await svc.purgeAppliedRawData({ olderThanMs: 1000, confirm: false });
    expect(dry.matched).toBeGreaterThanOrEqual(1);
    expect(dry.purged).toBe(0);
    expect(JSON.stringify((await rowOf(applied.id))?.raw)).toContain("sensible");

    // Confirm: vacía raw_data del applied; conserva fila + patient_id.
    const run = await svc.purgeAppliedRawData({ olderThanMs: 1000, confirm: true });
    expect(run.purged).toBeGreaterThanOrEqual(1);
    const appliedRow = await rowOf(applied.id);
    expect(appliedRow?.raw).toEqual({});
    expect(appliedRow?.pid).toBeTruthy();

    // El lote pending no se tocó.
    expect(JSON.stringify((await rowOf(pending.id))?.raw)).toContain("Pendiente");
  });

  it("rechaza un olderThanMs inválido", async () => {
    await expect(svc.purgeAppliedRawData({ olderThanMs: -1, confirm: true })).rejects.toThrow();
  });
});
