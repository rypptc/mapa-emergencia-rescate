/**
 * Integración — D3: Idempotency-Key scoped por usuario autenticado.
 *
 * La key se guarda hasheada y el índice único es `(created_by,
 * idempotency_key_hash)`, así un retry del mismo cliente reutiliza lote y dos
 * clientes distintos no colisionan por usar la misma key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import "./helpers";
import request from "supertest";
import { randomUUID } from "crypto";
import { ensureSeed, makeUserWithCaps } from "./helpers";

let app: import("express").Express;

beforeAll(async () => {
  await ensureSeed();
  app = (await import("@/server")).app;
});

const rows = [{ name: "Paciente Demo Idempotencia", hospital: "Hospital Demo" }];

describe("createImport — Idempotency-Key scoped (D3)", () => {
  it("reutiliza el mismo lote para el mismo usuario y key", async () => {
    const user = await makeUserWithCaps(["patient:import"]);
    const key = `idem-${randomUUID()}`;

    const first = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${user.token}`)
      .set("Idempotency-Key", key)
      .send({ source: "test", rows });
    expect(first.status).toBe(202);

    const second = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${user.token}`)
      .set("Idempotency-Key", key)
      .send({ source: "test", rows });
    expect(second.status).toBe(202);
    expect(second.body.import.id).toBe(first.body.import.id);
    expect(second.body.jobId).toBe(first.body.jobId);
    expect(second.body.import).not.toHaveProperty("reusedExisting");

    const { getDb, schema } = await import("@/db");
    const { and, eq } = await import("drizzle-orm");
    const imports = await getDb()
      .select({ id: schema.patientImports.id, hash: schema.patientImports.idempotencyKeyHash })
      .from(schema.patientImports)
      .where(
        and(
          eq(schema.patientImports.createdBy, user.id),
          eq(schema.patientImports.source, "test"),
        ),
      );
    const matching = imports.filter((imp) => imp.id === first.body.import.id);
    expect(matching).toHaveLength(1);
    expect(matching[0]?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(matching[0]?.hash).not.toBe(key);
  });

  it("permite la misma key para usuarios distintos", async () => {
    const userA = await makeUserWithCaps(["patient:import"]);
    const userB = await makeUserWithCaps(["patient:import"]);
    const key = `idem-${randomUUID()}`;

    const first = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${userA.token}`)
      .set("Idempotency-Key", key)
      .send({ source: "test-a", rows });
    const second = await request(app)
      .post("/api/public/patient-imports")
      .set("Authorization", `Bearer ${userB.token}`)
      .set("Idempotency-Key", key)
      .send({ source: "test-b", rows });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.import.id).not.toBe(first.body.import.id);
  });
});
