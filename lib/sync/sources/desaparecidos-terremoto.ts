/**
 * Adaptador para desaparecidosterremotovenezuela.com (theempire.tech).
 *
 * Fuente: GET https://desaparecidos-terremoto-api.theempire.tech/api/personas
 * Respuesta: { items: [ { id, nombre, edad, ubicacion, descripcion, contacto,
 *              foto, estado, localizado*, createdAt, updatedAt } ] }
 *
 * Notas:
 * - La API ignora la paginación y devuelve todo el set (ver RFC §3.5). Si se
 *   pasa `limit`, recortamos del lado del cliente.
 * - `contacto` son teléfonos en claro: NO se importan salvo que se active
 *   explícitamente el flag (ver RFC §6).
 */

import type { SourceAdapter, FetchCtx, ExternalPerson } from "../types";
import { normalizeAge, toEpochMs, httpUrlOrNull } from "../normalize";

const SOURCE_ID = "desaparecidosterremotovenezuela.com";
const DEFAULT_URL =
  "https://desaparecidos-terremoto-api.theempire.tech/api/personas";
/** La API entera tarda; le damos margen pero acotado. */
const FETCH_TIMEOUT_MS = 90_000;

interface ApiPerson {
  id?: string;
  nombre?: string;
  edad?: number | null;
  ubicacion?: string | null;
  descripcion?: string | null;
  contacto?: string | null;
  foto?: string | null;
  estado?: string | null;
  localizadoPor?: string | null;
  localizadoContacto?: string | null;
  localizadoRelacion?: string | null;
  localizadoNota?: string | null;
  createdAt?: number | string | null;
  updatedAt?: number | string | null;
}

function sourceUrl(): string {
  return process.env.SOURCE_DESAPARECIDOS_URL || DEFAULT_URL;
}

/** Por defecto NO se importa el contacto (riesgo de extorsión). */
function importContact(): boolean {
  return process.env.SOURCE_DESAPARECIDOS_IMPORT_CONTACT === "true";
}

function mapStatus(estado: string | null | undefined): "active" | "found" {
  return estado === "localizado" ? "found" : "active";
}

function resolutionNote(r: ApiPerson): string | null {
  const parts = [
    r.localizadoNota?.trim(),
    r.localizadoPor
      ? `Reportado por: ${r.localizadoPor}` +
        (r.localizadoRelacion ? ` (${r.localizadoRelacion})` : "")
      : null,
  ].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
}

function mapPerson(r: ApiPerson): ExternalPerson | null {
  const externalId = String(r.id ?? "").trim();
  const name = String(r.nombre ?? "").trim();
  if (!externalId || !name) return null;

  const status = mapStatus(r.estado);
  return {
    externalId,
    source: SOURCE_ID,
    sourceUrl: "https://desaparecidosterremotovenezuela.com/",
    name,
    age: normalizeAge(r.edad),
    lastSeen: r.ubicacion ?? null,
    description: r.descripcion ?? null,
    contact: importContact() ? (r.contacto ?? null) : null,
    photoUrl: httpUrlOrNull(r.foto),
    status,
    resolutionNote: status === "found" ? resolutionNote(r) : null,
    resolvedAt: status === "found" ? toEpochMs(r.updatedAt) : null,
    createdAt: toEpochMs(r.createdAt),
    updatedAt: toEpochMs(r.updatedAt),
  };
}

export const desaparecidosTerremotoAdapter: SourceAdapter = {
  id: SOURCE_ID,
  label: "Desaparecidos Terremoto Venezuela",
  kind: "json-api",

  async fetchAll(ctx: FetchCtx): Promise<ExternalPerson[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    // Si el motor ya pasó una señal, encadenamos el abort.
    ctx.signal?.addEventListener("abort", () => controller.abort());

    let res: Response;
    try {
      res = await fetch(sourceUrl(), {
        headers: {
          accept: "application/json",
          "user-agent": ctx.userAgent,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} al consultar ${SOURCE_ID}`);
    }

    const body = (await res.json()) as { items?: ApiPerson[] } | ApiPerson[];
    const items = Array.isArray(body) ? body : (body.items ?? []);

    const people: ExternalPerson[] = [];
    for (const raw of items) {
      const person = mapPerson(raw);
      if (person) people.push(person);
      if (ctx.limit && people.length >= ctx.limit) break;
    }
    return people;
  },
};
