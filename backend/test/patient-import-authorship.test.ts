/**
 * Integración — D5: autoría confiable vs origen declarado en la creación de un
 * lote de importación de pacientes (#151).
 *
 * Contrato: `created_by` es AUTORÍA VERIFICADA (sale de la credencial, req.user,
 * NO del body → no spoofeable). `source` es una etiqueta de origen DECLARADA por
 * el cliente: se guarda tal cual, pero no representa autoría ni se usa para
 * auth/dedup. Este test fija ambas cosas.
 *
 * Requiere el stack local arriba (docker compose up): DATABASE_URL + VALKEY_URL.
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { ensureSeed, makeUserWithCaps } from "./helpers";

let app: import("express").Express;

beforeAll(async () => {
  await ensureSeed();
  app = (await import("@/server")).app;
});

describe("createImport — autoría confiable vs origen declarado (D5)", () => {
  it("created_by sale de la credencial; source declarado no se confunde con autoría", async () => {
    const user = await makeUserWithCaps(["patient:import"]);

    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${user.token}`)
      // El cliente intenta declarar una autoría falsa vía `source`.
      .send({ source: "spoof", rows: [{ name: "Demo Anon", hospital: "Hospital Demo" }] });

    expect(res.status).toBe(202);
    const imp = res.body.import;
    // Autoría VERIFICADA: del usuario autenticado, no del body.
    expect(imp.createdBy).toBe(user.id);
    // `source` se guarda como la etiqueta declarada (no se reescribe como autoría
    // ni se rechaza): es solo procedencia declarada, no confiable.
    expect(imp.source).toBe("spoof");
  });
});
