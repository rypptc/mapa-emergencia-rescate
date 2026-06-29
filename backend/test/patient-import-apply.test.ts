/**
 * Integración de `applyImport` (#151) — enfocado en la garantía de privacidad A0
 * (ver #117): la importación NO debe propagar `notes` crudas al paciente final,
 * porque el campo `notes` se expone hoy en la búsqueda pública de pacientes. El
 * crudo sigue confinado en `raw_data` (staging restringido), no se pierde.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { randomUUID } from "crypto";

let app: import("express").Express;

beforeAll(async () => {
  app = (await import("@/server")).app;
});

describe("applyImport — privacidad A0 (#117)", () => {
  it("no propaga notas crudas al paciente final, pero las conserva en staging", async () => {
    const { getDb, schema } = await import("@/db");
    const { createImport, processImport, applyImport } = await import(
      "@/services/patient-imports"
    );
    const { eq } = await import("drizzle-orm");
    const db = getDb();

    // Hospital de prueba con nombre único (la resolución es por nombre exacto).
    const hospitalId = randomUUID();
    const hospitalName = `Hospital Demo ${hospitalId.slice(0, 8)}`;
    await db.insert(schema.hospitals).values({
      id: hospitalId,
      name: hospitalName,
      createdAt: Date.now(),
    });

    // Nota sensible SINTÉTICA (cédula demo + dato médico). Nunca debe salir.
    const patientName = `Paciente Demo ${hospitalId.slice(0, 8)}`;
    const sensitiveNote = "CI V-0.000.000 (demo), diagnóstico confidencial demo";

    // Lote → staging → procesar (resuelve hospital, valida, dedup) → aplicar.
    const created = await createImport(
      {
        source: "test",
        rows: [{ name: patientName, hospital: hospitalName, age: 30, notes: sensitiveNote }],
      },
      null,
    );
    const processed = await processImport(created.id);
    expect(processed.counts.valid).toBe(1);
    const applied = await applyImport(created.id, null);
    expect(applied.counts.applied).toBe(1);

    // 1) La búsqueda pública NO devuelve la nota sensible.
    // (limit explícito: la ruta no aplica el default(50) bajo Express 5 — ver nota.)
    const res = await request(app)
      .get("/api/patients/search")
      .query({ q: patientName, limit: 50 });
    expect(res.status).toBe(200);
    const match = res.body.results.find(
      (r: { patient: { name: string; notes: string } }) => r.patient.name === patientName,
    );
    expect(match).toBeDefined();
    expect(match.patient.notes).toBe("");
    expect(JSON.stringify(res.body)).not.toContain("confidencial");

    // 2) El crudo SIGUE confinado en staging (no se perdió, solo no se expone).
    const rows = await db
      .select({ rawData: schema.patientImportRows.rawData })
      .from(schema.patientImportRows)
      .where(eq(schema.patientImportRows.importId, created.id));
    expect(JSON.stringify(rows[0]?.rawData)).toContain("confidencial");
  });
});
