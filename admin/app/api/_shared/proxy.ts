/**
 * Helpers compartidos para los BFF que proxyean al backend con la sesión.
 *
 * Centraliza el patrón: crea el cliente autenticado (cookie→Bearer), y mapea el
 * ApiError del HttpClient a un status HTTP coherente. El backend hace la
 * autorización real (requireCapability); aquí solo propagamos el resultado.
 */
import { NextResponse } from "next/server";
import type { ApiError } from "../../../src/shared/result";
import { BFF_CACHE_HEADERS } from "./bff-cache";

export function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: BFF_CACHE_HEADERS });
}

export const unauthorized = () => json({ error: "Unauthorized" }, 401);

/** Mapea un ApiError del cliente a la respuesta del BFF. */
export function mapApiError(error: ApiError): NextResponse {
  if (error.kind === "auth") return json({ error: "Unauthorized" }, 401);
  if (error.kind === "http" && error.status === 403) return json({ error: "Forbidden" }, 403);
  if (error.kind === "http" && error.status === 404) return json({ error: "Not found" }, 404);
  if (error.kind === "http" && error.status === 400) return json({ error: "Datos inválidos." }, 400);
  if (error.kind === "http" && error.status === 429)
    return json({ error: "Demasiados intentos. Espera unos minutos." }, 429);
  return json({ error: "Upstream service error" }, 502);
}
