/**
 * Integración (#151, Fase 4) — creación de lotes en JSON, CSV y XLSX.
 *
 * Dos niveles, a propósito:
 *   - ROUTE (`POST /api/public/patient-imports`): valida el CONTRATO de entrada —
 *     202, contentType registrado y que el archivo CSV/XLSX se MATERIALIZA a la
 *     misma forma de staging que el JSON (counts.total). No dispara el procesado
 *     aquí: el route encola y el worker procesa async; correr `processImport`
 *     contra un id ya encolado competiría con cualquier worker vivo (flaky).
 *   - SERVICE directo: `createImport` (no encola) → `processImport` prueba, sin
 *     carrera, que las filas PARSEADAS de CSV/XLSX normalizan/validan igual que el
 *     JSON (mismo patrón que patient-import-hospital-batch).
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 * PII 100% sintética: hospitales/nombres demo, nunca datos reales.
 */
import { randomUUID } from "crypto";

import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";

import { ensureSeed, makeUserWithCaps } from "./helpers";
import { buildXlsxCorruptDeflate, buildXlsxShared } from "./xlsx-fixture";
import { CONTENT_TYPE, parseImportFile } from "@/services/patient-import-parse";

const XLSX_MIME = CONTENT_TYPE.XLSX;

let app: import("express").Express;
let token: string;

beforeAll(async () => {
  await ensureSeed();
  app = (await import("@/server")).app;
  token = (await makeUserWithCaps(["patient:import"])).token;
});

async function makeHospital(name: string): Promise<string> {
  const { getDb, schema } = await import("@/db");
  const db = getDb();
  const id = randomUUID();
  await db.insert(schema.hospitals).values({ id, name, createdAt: Date.now() });
  return id;
}

function post(body: Record<string, unknown>) {
  return request(app)
    .post("/api/public/patient-imports")
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

describe("createImport por formato — contrato del route (Fase 4)", () => {
  it("JSON sigue funcionando (no regresión): 202 y staging", async () => {
    const res = await post({ source: "test", rows: [{ name: "Demo Json", hospital: "Hospital Demo" }] });
    expect(res.status).toBe(202);
    expect(res.body.import.contentType).toBe("application/json");
    expect(res.body.import.counts.total).toBe(1);
  });

  it("CSV en fileBase64: 202 y se materializa a staging (counts.total)", async () => {
    const csv = "name,hospital,age\nDemo Csv,Hospital Demo,45\nOtro Csv,Hospital Demo,30";
    const res = await post({
      contentType: "text/csv",
      fileBase64: Buffer.from(csv, "utf8").toString("base64"),
    });
    expect(res.status).toBe(202);
    expect(res.body.import.contentType).toBe("text/csv");
    expect(res.body.import.counts.total).toBe(2);
  });

  it("XLSX en fileBase64: 202 y se materializa a staging (counts.total)", async () => {
    const xlsx = buildXlsxShared([
      ["name", "hospital", "age"],
      ["Demo Xlsx", "Hospital Demo", "30"],
    ]);
    const res = await post({ contentType: XLSX_MIME, fileBase64: xlsx.toString("base64") });
    expect(res.status).toBe(202);
    expect(res.body.import.contentType).toBe(XLSX_MIME);
    expect(res.body.import.counts.total).toBe(1);
  });

  it("archivo ilegible falla el LOTE con 400 (error claro por-lote)", async () => {
    const res = await post({
      contentType: XLSX_MIME,
      fileBase64: Buffer.from("no soy xlsx").toString("base64"),
    });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  it("CSV sin filas de datos (solo cabecera) → 400", async () => {
    const res = await post({
      contentType: "text/csv",
      fileBase64: Buffer.from("name,hospital", "utf8").toString("base64"),
    });
    expect(res.status).toBe(400);
  });

  it("CSV con campo que excede el cap de rowSchema (notes > 600) → 400", async () => {
    // Las filas parseadas de archivo deben respetar las MISMAS cotas que el JSON
    // (rowSchema). Un notes de 700 chars debe fallar el LOTE con 400, no colarse.
    const longNotes = "x".repeat(700);
    const csv = `name,hospital,notes\nDemo Csv,Hospital Demo,${longNotes}`;
    const res = await post({
      contentType: "text/csv",
      fileBase64: Buffer.from(csv, "utf8").toString("base64"),
    });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });

  it("XLSX con deflate corrupto falla el LOTE con 400 (no 500)", async () => {
    const res = await post({
      contentType: XLSX_MIME,
      fileBase64: buildXlsxCorruptDeflate().toString("base64"),
    });
    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe("string");
  });
});

describe("filas parseadas de CSV/XLSX normalizan/validan igual que JSON", () => {
  it("CSV: las filas parseadas resuelven hospital y quedan válidas", async () => {
    const { createImport, processImport } = await import("@/services/patient-imports");
    const hospital = `Hospital CSV ${randomUUID().slice(0, 8)}`;
    await makeHospital(hospital);
    const csv = `name,hospital,age\nDemo Csv,${hospital},45`;
    const rows = parseImportFile(CONTENT_TYPE.CSV, Buffer.from(csv, "utf8").toString("base64"));
    const created = await createImport({ source: "test", contentType: "text/csv", rows }, null);
    const processed = await processImport(created.id);
    expect(processed.counts.total).toBe(1);
    expect(processed.counts.valid).toBe(1);
  });

  it("XLSX: las filas parseadas resuelven hospital y quedan válidas", async () => {
    const { createImport, processImport } = await import("@/services/patient-imports");
    const hospital = `Hospital Xlsx ${randomUUID().slice(0, 8)}`;
    await makeHospital(hospital);
    const xlsx = buildXlsxShared([
      ["name", "hospital", "age"],
      ["Demo Xlsx", hospital, "30"],
    ]);
    const rows = parseImportFile(CONTENT_TYPE.XLSX, xlsx.toString("base64"));
    const created = await createImport({ source: "test", contentType: XLSX_MIME, rows }, null);
    const processed = await processImport(created.id);
    expect(processed.counts.total).toBe(1);
    expect(processed.counts.valid).toBe(1);
  });
});
