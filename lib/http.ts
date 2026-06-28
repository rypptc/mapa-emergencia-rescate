import { createHash } from "crypto";
import { NextResponse } from "next/server";

/**
 * Memoización de `{json, etag}` por referencia del objeto de datos. `cached()`
 * devuelve la MISMA referencia durante su ventana de TTL, así que en cada hit
 * subsiguiente reusamos el JSON serializado + el ETag ya calculados en vez de
 * re-stringify + re-sha1 por request (audit B-9). WeakMap: se libera solo cuando
 * el objeto cacheado se descarta. Para objetos no cacheados (referencia nueva
 * por request) simplemente se calcula una vez y se descarta — sin coste extra.
 */
const etagMemo = new WeakMap<object, { json: string; etag: string }>();

function serializeWithEtag(data: unknown): { json: string; etag: string } {
  if (data !== null && typeof data === "object") {
    const hit = etagMemo.get(data as object);
    if (hit) return hit;
    const json = JSON.stringify(data);
    const etag = `"${createHash("sha1").update(json).digest("base64")}"`;
    const entry = { json, etag };
    etagMemo.set(data as object, entry);
    return entry;
  }
  const json = JSON.stringify(data);
  return { json, etag: `"${createHash("sha1").update(json).digest("base64")}"` };
}

/**
 * Responde JSON con un ETag derivado del contenido. Si el cliente manda
 * `If-None-Match` con ese mismo ETag, devuelve `304 Not Modified` sin cuerpo.
 *
 * Bajo polling masivo esto corta ancho de banda y CPU de parseo en el cliente:
 * mientras los datos no cambian, cada request se resuelve con un 304 vacío. El
 * JSON+ETag se memoiza por referencia (ver serializeWithEtag): un objeto
 * cacheado solo se serializa/hashea una vez por ventana de TTL.
 */
export function jsonWithEtag(
  request: Request,
  data: unknown,
  headers: Record<string, string> = {},
): NextResponse {
  const { json, etag } = serializeWithEtag(data);
  const ifNoneMatch = request.headers.get("if-none-match");

  if (ifNoneMatch && ifNoneMatch === etag) {
    return new NextResponse(null, { status: 304, headers: { ...headers, ETag: etag } });
  }
  return new NextResponse(json, {
    status: 200,
    headers: { ...headers, ETag: etag, "Content-Type": "application/json" },
  });
}
