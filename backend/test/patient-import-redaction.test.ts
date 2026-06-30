/**
 * Contrato de PRIVACIDAD de la superficie pública de patient-imports (#151).
 *
 * El riesgo #1 del proyecto es filtrar PII. Las respuestas de GET /:id y
 * /:id/rows son allowlists: NUNCA deben exponer el dato crudo, el documento/
 * cédula, las notas, el contacto, el HMAC del documento ni el hash de la clave
 * de idempotencia. Estos asserts FIJAN ese contrato como regresión.
 *
 * El vector más peligroso es `toRowDTO`: los candidatos de dedup traen, a nivel
 * servicio, el `documentHash` (HMAC de la cédula) de pacientes EXISTENTES. Si
 * alguien "simplifica" el serializador a `...candidate`, ese hash se filtraría
 * por la API → un oráculo de presencia ("¿esta cédula ya está en el hospital?").
 * Aquí se rompe el test, no en producción.
 *
 * A diferencia de patient-import-apply.test.ts (redacción a nivel DB del paciente
 * final), esto fija la redacción de la RESPUESTA HTTP de los endpoints públicos.
 *
 * PII sintética: cédulas/nombres/notas demo, nunca datos reales.
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { randomUUID, createHash } from "crypto";
import { ensureSeed, makeUserWithCaps } from "./helpers";

let app: import("express").Express;
let token: string;

beforeAll(async () => {
  await ensureSeed();
  app = (await import("@/server")).app;
  token = (await makeUserWithCaps(["patient:import"])).token;
});

async function freshHospital(): Promise<{ id: string; name: string }> {
  const { getDb, schema } = await import("@/db");
  const db = getDb();
  const id = randomUUID();
  const name = `Hospital Redaccion ${id.slice(0, 8)}`;
  await db.insert(schema.hospitals).values({ id, name, createdAt: Date.now() });
  return { id, name };
}

// PII sintética claramente demo. Los dígitos no aparecen como subcadena de un
// epoch-ms (que en 2026 empieza por "17…") ni de un UUID, así que un match en la
// respuesta sería un leak real, no un falso positivo.
const DOCUMENT_DIGITS = "98765432";
const DOCUMENT_ID = "V-98.765.432";
const SENSITIVE_NOTES = "nota-confidencial-demo-xyz";
const SENSITIVE_CONTACT = "contacto-demo-0001";

describe("patient-imports — contrato de privacidad de la superficie pública (#151)", () => {
  it("GET /:id/rows redacta crudo, documento, notas, contacto y document_hash", async () => {
    const { createImport, processImport, applyImport } = await import(
      "@/services/patient-imports"
    );
    const hospital = await freshHospital();

    // 1) Paciente base con documento → genera un document_hash en hospital_patients.
    const first = await createImport(
      {
        source: "test",
        rows: [{ name: "Alicia Demo", hospital: hospital.name, age: 41, documentId: DOCUMENT_ID }],
      },
      null,
    );
    await processImport(first.id);
    await applyImport(first.id, null);

    // 2) Segundo lote: MISMO documento + notas/contacto sensibles. La fila queda
    //    duplicada y sus dedupCandidates referencian al paciente existente (que
    //    trae document_hash a nivel servicio). Es el escenario de leak a fijar.
    const second = await createImport(
      {
        source: "test",
        rows: [
          {
            name: "Beatriz Otra",
            hospital: hospital.name,
            age: 73,
            documentId: DOCUMENT_ID,
            notes: SENSITIVE_NOTES,
            contact: SENSITIVE_CONTACT,
          },
        ],
      },
      null,
    );
    await processImport(second.id);

    const res = await request(app)
      .get(`/api/public/patient-imports/${second.id}/rows`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    // El crudo sensible jamás sale por la API.
    expect(body).not.toContain(SENSITIVE_NOTES);
    expect(body).not.toContain(SENSITIVE_CONTACT);
    expect(body).not.toContain(DOCUMENT_DIGITS);
    // El HMAC del documento (presente en el candidato a nivel servicio) se redacta.
    expect(body).not.toContain("documentHash");

    // Confirma el escenario peligroso y que el candidato SOLO expone keys allowlist
    // (patientId, name, reason) — nunca document_hash ni la edad del paciente real.
    const dupRow = res.body.items.find(
      (r: { dedupStatus: string }) => r.dedupStatus === "duplicate",
    );
    expect(dupRow).toBeTruthy();
    expect(dupRow.dedupCandidates.length).toBeGreaterThan(0);
    const allowedCandidateKeys = new Set(["patientId", "name", "reason"]);
    for (const cand of dupRow.dedupCandidates) {
      for (const key of Object.keys(cand)) {
        expect(allowedCandidateKeys.has(key)).toBe(true);
      }
      expect(cand).not.toHaveProperty("documentHash");
      expect(cand).not.toHaveProperty("age");
    }
  });

  it("GET /:id no filtra el hash de la clave de idempotencia", async () => {
    const idemKey = `idem-demo-${randomUUID()}`;
    const createRes = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .set("Idempotency-Key", idemKey)
      .send({ source: "test", rows: [{ name: "Carlos Demo", hospital: "Hospital Demo" }] });
    expect(createRes.status).toBe(202);
    const id = createRes.body.import.id as string;

    const res = await request(app)
      .get(`/api/public/patient-imports/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    const body = JSON.stringify(res.body);
    // Ni la clave en claro, ni su hash, ni el nombre del campo interno.
    expect(body).not.toContain("idempotencyKeyHash");
    expect(body).not.toContain(idemKey);
    const idemHash = createHash("sha256").update(idemKey).digest("hex");
    expect(body).not.toContain(idemHash);
  });
});
