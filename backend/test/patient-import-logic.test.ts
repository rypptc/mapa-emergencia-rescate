/**
 * Pruebas de la lógica PURA de importación de pacientes (#151). Sin DB: cubren
 * normalización, validación y la POLÍTICA de deduplicación (qué es duplicado,
 * qué necesita revisión, qué es único) para dejar el comportamiento explícito.
 */
import { describe, expect, it } from "vitest";
import {
  classifyDedup,
  documentDigits,
  mapCondition,
  mapStatus,
  nameKey,
  normalizeAge,
  normalizeName,
  normalizeRow,
  validateRow,
  type DedupCandidate,
  type NormalizedRow,
} from "@/services/patient-import-logic";

describe("normalización", () => {
  it("normalizeName colapsa espacios y recorta", () => {
    expect(normalizeName("  José   Pérez  ")).toBe("José Pérez");
    expect(normalizeName(undefined)).toBe("");
  });

  it("nameKey es minúscula, sin acentos ni signos (clave de bloqueo)", () => {
    expect(nameKey("José Pérez!")).toBe("jose perez");
    expect(nameKey("MARÍA  José")).toBe("maria jose");
    expect(nameKey("")).toBe("");
  });

  it("normalizeAge acota 0..150 y rechaza basura", () => {
    expect(normalizeAge("33")).toBe(33);
    expect(normalizeAge(40.9)).toBe(40);
    expect(normalizeAge(-1)).toBeNull();
    expect(normalizeAge(999)).toBeNull();
    expect(normalizeAge("abc")).toBeNull();
    expect(normalizeAge(null)).toBeNull();
  });

  it("documentDigits extrae dígitos y descarta señales cortas", () => {
    expect(documentDigits("V-12.345.678")).toBe("12345678");
    expect(documentDigits("12")).toBeNull();
    expect(documentDigits(undefined)).toBeNull();
  });

  it("mapCondition/mapStatus mapean sinónimos ES/EN y avisan lo desconocido", () => {
    expect(mapCondition("grave").value).toBe("serious");
    expect(mapCondition("CRÍTICO").value).toBe("critical");
    expect(mapCondition("xyz")).toMatchObject({ value: "unknown" });
    expect(mapCondition("xyz").warning).toBeDefined();

    expect(mapStatus("ingresado").value).toBe("hospitalized");
    expect(mapStatus("dado de alta").value).toBe("discharged");
    expect(mapStatus("fallecido").value).toBe("deceased");
    expect(mapStatus("???").value).toBe("hospitalized");
  });

  it("normalizeRow saca el documento a dígitos y conserve los avisos", () => {
    const row = normalizeRow({
      name: "  Ana  Díaz ",
      age: "x",
      condition: "estable",
      status: "raro",
      hospital: "Hospital Central",
      documentId: "V-9.876.543",
    });
    expect(row.name).toBe("Ana Díaz");
    expect(row.normalizedKey).toBe("ana diaz");
    expect(row.age).toBeNull();
    expect(row.condition).toBe("stable");
    expect(row.status).toBe("hospitalized");
    expect(row.documentDigits).toBe("9876543");
    expect(row.warnings.length).toBe(1); // estado "raro"
  });
});

describe("validación de identidad mínima", () => {
  const base: NormalizedRow = {
    name: "Ana Díaz",
    normalizedKey: "ana diaz",
    age: 30,
    condition: "stable",
    status: "hospitalized",
    sourceHospital: "Hospital Central",
    hospitalIdHint: null,
    documentDigits: null,
    notes: "",
    contact: "",
    warnings: [],
  };

  it("acepta una fila con nombre y hospital resuelto", () => {
    expect(validateRow(base, true).errors).toEqual([]);
  });

  it("rechaza sin nombre", () => {
    expect(validateRow({ ...base, name: "" }, true).errors).toContain(
      "Falta el nombre del paciente.",
    );
  });

  it("rechaza si el hospital no se resolvió", () => {
    expect(validateRow(base, false).errors.length).toBe(1);
  });
});

describe("clasificación de deduplicación", () => {
  const row: NormalizedRow = {
    name: "Ana Díaz",
    normalizedKey: "ana diaz",
    age: 30,
    condition: "stable",
    status: "hospitalized",
    sourceHospital: "Hospital Central",
    hospitalIdHint: null,
    documentDigits: "9876543",
    notes: "",
    contact: "",
    warnings: [],
  };

  it("sin candidatos → único", () => {
    expect(classifyDedup(row, []).status).toBe("unique");
  });

  it("documento exacto → duplicado (confianza 1)", () => {
    const cand: DedupCandidate = {
      patientId: "p1",
      name: "Otra Persona",
      age: 99,
      documentDigits: "9876543",
    };
    const v = classifyDedup(row, [cand]);
    expect(v.status).toBe("duplicate");
    expect(v.confidence).toBe(1);
  });

  it("mismo nombre + edad compatible (una nula) → duplicado", () => {
    const cand: DedupCandidate = { patientId: "p1", name: "Ana Diaz", age: null, documentDigits: null };
    expect(classifyDedup({ ...row, documentDigits: null }, [cand]).status).toBe("duplicate");
  });

  it("mismo nombre, edad incompatible → needs_review", () => {
    const cand: DedupCandidate = { patientId: "p1", name: "Ana Diaz", age: 70, documentDigits: null };
    const v = classifyDedup({ ...row, documentDigits: null }, [cand]);
    expect(v.status).toBe("needs_review");
  });
});
