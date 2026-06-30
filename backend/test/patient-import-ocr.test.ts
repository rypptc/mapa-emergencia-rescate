/**
 * Integración — frontera OCR/ICR (imagen/PDF) del ingest de importación (#151/#158).
 *
 * INVARIANTE: la entrada OCR/ICR (application/pdf o image/*) se RECHAZA en el
 * ingest con 501 Not Implemented, ANTES de decodificar base64, parsear o escribir
 * en DB. No hay motor de OCR configurado y el reconocimiento de imágenes/PDF y de
 * texto manuscrito SIEMPRE exige revisión humana. Por eso esta entrada nunca puede
 * crear una fila de staging, llegar a "valid"/listo ni auto-aplicarse, y la
 * respuesta 501 nunca refleja el dato crudo subido. Los datos tabulares (JSON/CSV/
 * XLSX) siguen aceptándose sin regresión.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 * Datos 100% sintéticos/anónimos — sin PII.
 */
import { randomUUID } from "crypto";
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { ensureSeed, makeUserWithCaps } from "./helpers";

let app: import("express").Express;
let token: string;

beforeAll(async () => {
  await ensureSeed();
  app = (await import("@/server")).app;
  token = (await makeUserWithCaps(["patient:import"])).token;
});

const rows = [{ name: "Demo Anon", hospital: "Hospital Demo" }];

describe("createImport — frontera OCR/ICR (imagen/PDF) → 501", () => {
  it("application/pdf con rows → 501 con mensaje claro de OCR/revisión humana", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/pdf", rows });
    expect(res.status).toBe(501);
    expect(res.body.error).toContain("OCR");
    expect(res.body.error).toContain("revisión humana");
    expect(res.body.import).toBeUndefined();
  });

  it("image/png con rows → 501", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "image/png", rows });
    expect(res.status).toBe(501);
  });

  it("image/jpeg → 501", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "image/jpeg", rows });
    expect(res.status).toBe(501);
  });

  it("el 501 no refleja el archivo crudo (fileBase64)", async () => {
    // Marcador sintético reconocible: si el cuerpo del 501 lo contuviera, el
    // archivo crudo se estaría filtrando en la respuesta.
    const RAW = Buffer.from("RAW-OCR-IMAGE-BYTES-DEMO").toString("base64");
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/pdf", fileBase64: RAW });
    expect(res.status).toBe(501);
    // Esto fija que la entrada OCR/ICR no se persiste, no se auto-aplica y no se
    // filtra: se rechaza ANTES de decodificar el base64.
    expect(JSON.stringify(res.body)).not.toContain(RAW);
    expect(JSON.stringify(res.body)).not.toContain("RAW-OCR-IMAGE-BYTES-DEMO");
  });

  it("datos tabulares (JSON) siguen aceptándose (202) — sin regresión", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/json", rows });
    expect(res.status).toBe(202);
  });

  // El 501 anterior fija que la respuesta no filtra el crudo, pero NO observa el
  // efecto en DB. Este caso cierra el hueco: la entrada OCR/ICR se rechaza ANTES
  // de `service.createImport` y de `writeAudit` (ver route líneas 234-240), así
  // que no puede dejar NINGÚN rastro persistido — ni fila de staging ni auditoría.
  it("OCR/ICR (PDF) no crea fila en patient_imports ni entrada en audit_log", async () => {
    // Usuario propio (createdBy aislado) → señal inequívoca: tras un 501 no debe
    // existir ninguna fila atribuida a este actor. `source` sintético único añade
    // una segunda señal independiente. Datos 100% demo, sin PII.
    const { id: userId, token: ownToken } = await makeUserWithCaps(["patient:import"]);
    const uniqueSource = `demo-ocr-no-persist-${randomUUID()}`;
    const uniqueIdemKey = `demo-idem-${randomUUID()}`;

    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${ownToken}`)
      .set("Idempotency-Key", uniqueIdemKey)
      .send({ contentType: "application/pdf", source: uniqueSource, rows });
    expect(res.status).toBe(501);

    const { getDb, schema } = await import("@/db");
    const { and, eq } = await import("drizzle-orm");
    const db = getDb();

    // Sin staging: ni por autoría verificada (createdBy) ni por la etiqueta source.
    const importsByActor = await db
      .select({ id: schema.patientImports.id })
      .from(schema.patientImports)
      .where(eq(schema.patientImports.createdBy, userId));
    expect(importsByActor).toHaveLength(0);

    const importsBySource = await db
      .select({ id: schema.patientImports.id })
      .from(schema.patientImports)
      .where(eq(schema.patientImports.source, uniqueSource));
    expect(importsBySource).toHaveLength(0);

    // Sin auditoría: el 501 corta antes de writeAudit("patient-import.create").
    const audits = await db
      .select({ id: schema.auditLog.id })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actorUserId, userId),
          eq(schema.auditLog.action, "patient-import.create"),
        ),
      );
    expect(audits).toHaveLength(0);
  });
});
