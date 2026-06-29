/**
 * Integración — C7: la fase 1 solo procesa JSON. Un `contentType` distinto de
 * "application/json" se rechaza con 400 (no se procesa el payload como JSON a
 * ciegas). "application/json" (o ausente) se acepta.
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

describe("createImport — validación de contentType (C7)", () => {
  it("rechaza un contentType no soportado con 400", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "text/csv", rows });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("application/json");
  });

  it("acepta application/json (202)", async () => {
    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${token}`)
      .send({ contentType: "application/json", rows });
    expect(res.status).toBe(202);
  });
});
