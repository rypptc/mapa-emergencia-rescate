/**
 * Integración — frontera del ingest OCR/ICR con un proveedor CONFIGURADO (#151/#158).
 *
 * Complementa patient-import-ocr.test.ts (que cubre el caso DESHABILITADO → 501).
 * Aquí MINIMAX_API_KEY está presente (se fija antes de cargar la app y se limpia
 * al terminar para no contaminar otros archivos), así el route habilita SOLO la
 * imagen vía URL:
 *   - image/* + imageUrl     → 202 (lote OCR creado y encolado; la URL NO se expone).
 *   - image/* sin imageUrl    → 400 (no se acepta base64/rows para OCR).
 *   - application/pdf         → 501 (sin contrato de URL/almacenamiento todavía).
 *   - imageUrl en no-imagen   → 400 (campo fuera de lugar).
 *
 * No corre el worker: el lote queda "queued" (la extracción real la cubre
 * patient-import-ocr-ingest.test.ts inyectando el proveedor). Requiere el stack
 * local (DATABASE_URL + VALKEY_URL). Datos 100% sintéticos — sin PII.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { ensureSeed, makeUserWithCaps } from "./helpers";

let app: import("express").Express;
let token: string;

const IMAGE_URL = "https://example.test/demo-scan.jpg";

beforeAll(async () => {
  // DEBE fijarse antes de importar la app: config/env parsea process.env al cargar.
  process.env.MINIMAX_API_KEY = "demo-minimax-token-DO-NOT-LOG-0123456789";
  await ensureSeed();
  app = (await import("@/server")).app;
  token = (await makeUserWithCaps(["patient:import"])).token;
});

afterAll(() => {
  // Limpieza: no filtrar el provider habilitado a otros archivos del suite.
  delete process.env.MINIMAX_API_KEY;
});

describe("createImport — OCR/ICR con proveedor habilitado", () => {
  it("image/jpeg + imageUrl → 202 (lote OCR encolado; la URL no se expone)", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "image/jpeg", source: "demo-ocr", imageUrl: IMAGE_URL });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBeTruthy();
    expect(res.body.import.status).toBe("queued");
    expect(res.body.import.contentType).toBe("image/jpeg");
    // PRIVACIDAD: la URL de imagen nunca debe aparecer en la respuesta.
    expect(JSON.stringify(res.body)).not.toContain(IMAGE_URL);
    expect(JSON.stringify(res.body)).not.toContain("example.test");
  });

  it("image/png sin imageUrl → 400 (no se acepta base64/rows para OCR)", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "image/png", rows: [{ name: "Demo Anon" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("imageUrl");
  });

  it("application/pdf → 501 aunque el proveedor esté habilitado (sin URL contract)", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/pdf", rows: [{ name: "Demo Anon" }] });
    expect(res.status).toBe(501);
  });

  it("imageUrl con un contentType no-imagen → 400", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/json", imageUrl: IMAGE_URL, rows: [{ name: "Demo" }] });
    expect(res.status).toBe(400);
  });

  it("image/jpeg + fileBase64 (sin imageUrl) → 400 (OCR no acepta base64)", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({
        contentType: "image/jpeg",
        fileBase64: Buffer.from("demo").toString("base64"),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("imageUrl");
  });

  it("datos tabulares (JSON) siguen aceptándose (202) — sin regresión", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/json", rows: [{ name: "Demo Anon", hospital: "H Demo" }] });
    expect(res.status).toBe(202);
  });
});
