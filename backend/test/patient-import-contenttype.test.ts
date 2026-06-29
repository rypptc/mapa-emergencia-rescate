/**
 * Integración — validación de contentType. Fase 4: se admiten JSON, CSV y XLSX.
 *
 * - "application/json" (o ausente) con `rows` → 202.
 * - "text/csv"/XLSX EXIGEN `fileBase64`; declararlos sin archivo → 400.
 * - Un contentType fuera del set soportado → 400 (no se procesa a ciegas).
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 */
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

describe("createImport — validación de contentType (Fase 4)", () => {
  it("rechaza un contentType fuera del set soportado con 400", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/pdf", rows });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("contentType");
  });

  it("rechaza text/csv sin fileBase64 con 400", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "text/csv", rows });
    expect(res.status).toBe(400);
  });

  it("acepta application/json (202)", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/json", rows });
    expect(res.status).toBe(202);
  });
});
