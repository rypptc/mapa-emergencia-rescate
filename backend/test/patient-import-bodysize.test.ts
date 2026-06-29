/**
 * Integración — D2: el POST de creación de lote acepta payloads grandes (lotes
 * de hasta 2000 filas), por encima del parser global de 256kb. El router monta su
 * propio parser ampliado (4mb) y el path está en LARGE_BODY_POST_PATHS para saltar
 * el global. Sin el fix, un lote > 256kb daría 413 antes de llegar a la validación.
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

describe("createImport — tamaño de lote (D2)", () => {
  it("acepta un lote de 2000 filas (> 256kb) sin 413", async () => {
    const user = await makeUserWithCaps(["patient:import"]);

    // 2000 filas con un poco de relleno → payload bien por encima de 256kb
    // (~360KB), que el parser global rechazaría con 413.
    const rows = Array.from({ length: 2000 }, (_, i) => ({
      name: `Paciente Demo ${i}`,
      hospital: "Hospital Demo",
      notes: "x".repeat(120),
    }));
    const bodyBytes = Buffer.byteLength(JSON.stringify({ rows }));
    expect(bodyBytes).toBeGreaterThan(256 * 1024); // confirma que excede el global

    const res = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${user.token}`)
      .send({ source: "test", rows });

    expect(res.status).toBe(202);
    expect(res.body.import.counts.total).toBe(2000);
  });
});
