import { createHash } from "crypto";

const memoryHits = new Map<string, number[]>();
const DEFAULT_LIMIT = 8;
const WINDOW_MS = 60_000;

/**
 * Límite de peticiones en memoria por identificador (normalmente la IP).
 * Devuelve true si la petición está permitida dentro de la ventana actual.
 *
 * Nota: en serverless el contador es por instancia de función. Para frenar
 * spam puntual es suficiente; la protección principal ante tráfico masivo es
 * la caché de CDN sobre el endpoint de lectura.
 */
export async function checkRateLimit(
  identifier: string,
  limit: number = DEFAULT_LIMIT,
): Promise<boolean> {
  const now = Date.now();
  const hits = (memoryHits.get(identifier) ?? []).filter(
    (ts) => now - ts < WINDOW_MS,
  );
  if (hits.length >= limit) {
    memoryHits.set(identifier, hits);
    return false;
  }
  hits.push(now);
  memoryHits.set(identifier, hits);
  return true;
}

/**
 * Extrae la IP del cliente desde las cabeceras de la petición.
 *
 * NO usamos el primer valor de `x-forwarded-for`: el cliente lo controla y un
 * proxy lo ANTEPONE, así que el valor más a la izquierda es falsificable (deja
 * el rate-limit evadible cambiando el header). Preferimos:
 *  1. `TRUSTED_IP_HEADER` si está configurado (la cabecera que pone TU proxy de
 *     confianza, p. ej. `x-vercel-forwarded-for` o `cf-connecting-ip`). Tomamos
 *     el hop MÁS A LA DERECHA: cada proxy ANTEPONE su valor, así que el último
 *     elemento es el que añadió el proxy más cercano a la app (confiable), no el
 *     que inyectó el cliente.
 *  2. `x-real-ip` (la pone el proxy/plataforma, no el cliente).
 * Si no hay ninguna, caemos a "anon" (límite por instancia compartido).
 *
 * IMPORTANTE: `TRUSTED_IP_HEADER` NUNCA debe ser `x-forwarded-for` en prod si el
 * cliente puede alcanzarlo sin pasar por un proxy que lo reescriba.
 */
export function clientIp(request: Request): string {
  const trusted = process.env.TRUSTED_IP_HEADER;
  if (trusted) {
    const v = request.headers.get(trusted);
    if (v) {
      const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
      // hop más a la derecha = el que puso el proxy más cercano (no el cliente)
      if (parts.length) return parts[parts.length - 1]!;
    }
  }
  return request.headers.get("x-real-ip") ?? "anon";
}

/**
 * Hash estable de la IP del cliente para persistir (columnas `ip_hash`). NUNCA
 * guardes la IP en crudo: contexto humanitario, un leak expondría a quien
 * reportó/donó/confirmó. Salado con `IP_SALT` para evitar reversión por tabla
 * arcoíris del espacio IPv4. Sigue siendo determinístico → dedup por IP funciona.
 */
export function hashIp(request: Request): string {
  const ip = clientIp(request);
  const salt = process.env.IP_SALT ?? "";
  return createHash("sha256").update(ip + salt).digest("hex");
}
