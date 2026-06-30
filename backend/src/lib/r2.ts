/**
 * Cloudflare R2 upload helper para el request path (lado app).
 *
 * Las fotos nuevas subidas por los formularios públicos van directo a R2 aquí,
 * en vez de acumularse como base64 en Postgres. Mismo env + bucket + key scheme
 * que worker/r2.ts: `images/<table>/<id>.<ext>`, servido desde el CDN.
 *
 * Env (token R2 compartido):
 *   R2_ENDPOINT, R2_STATIC_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 *   R2_PUBLIC_BASE   base pública del CDN, p.ej. https://bucket.dreamit.software
 *
 * Política: si R2 está configurado, las subidas DEBEN tener éxito — un fallo
 * lanza (el endpoint lo expone; nunca caemos en silencio a base64-en-DB). Si R2
 * NO está configurado (dev local), `isR2Configured()` es false y los callers
 * mantienen el camino legado base64.
 *
 * Portado tal cual desde lib/r2.ts del app Next previo (lee process.env directo).
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

let _s3: S3Client | null = null;

/** True solo cuando TODAS las vars de R2 están — gatea el camino de escritura R2. */
export function isR2Configured(): boolean {
  return Boolean(
    process.env.R2_ENDPOINT &&
      process.env.R2_STATIC_BUCKET &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_PUBLIC_BASE,
  );
}

function s3(): S3Client {
  if (_s3) return _s3;
  _s3 = new S3Client({
    region: "auto", // R2 ignora la región pero el SDK exige una ("auto" es convencional)
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
    },
    forcePathStyle: true,
  });
  return _s3;
}

/**
 * Prefijo de namespace para las keys (aísla entornos en el MISMO bucket). En
 * prod va vacío -> keys `images/...` (sin cambio). En staging pon
 * R2_KEY_PREFIX=staging -> keys `staging/images/...`, para no pisar fotos de
 * prod. Debe aplicarse en TODOS los sitios que construyen una key (ver también
 * worker/r2.ts, worker/jobs/migratePhoto.ts y hubImage.ts).
 */
export function withPrefix(key: string): string {
  const prefix = (process.env.R2_KEY_PREFIX || "").replace(/^\/+|\/+$/g, "");
  return prefix ? `${prefix}/${key}` : key;
}

/** URL pública del CDN para una key almacenada. */
function publicUrl(key: string): string {
  const base = (process.env.R2_PUBLIC_BASE || "").replace(/\/$/, "");
  return `${base}/${key}`;
}

/** Parsea un `data:image/<mime>;base64,<payload>` a bytes validados. */
function parseDataUri(
  uri: string,
): { bytes: Buffer; contentType: string; ext: string } | null {
  const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(uri);
  if (!m) return null;
  const contentType = m[1]!;
  if (!ALLOWED_MIME.has(contentType)) return null;
  const bytes = Buffer.from(m[2]!, "base64");
  if (bytes.length === 0) return null;
  const ext = contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1]!;
  return { bytes, contentType, ext };
}

/**
 * Sube una imagen base64 (data URL) a R2 bajo `images/<table>/<id>.<ext>` y
 * devuelve su URL pública del CDN. Lanza si R2 está mal configurado, el data URL
 * es inválido, o el PUT falla — los callers no deben tragarse esto (hard-fail).
 *
 * El caller debe checar `isR2Configured()` primero; si es false, usa base64.
 */
export async function uploadPhotoDataUrl(
  dataUrl: string,
  table: string,
  id: string,
): Promise<string> {
  const parsed = parseDataUri(dataUrl);
  if (!parsed) throw new Error("Foto inválida: se esperaba JPG, PNG o WebP en base64.");
  const key = withPrefix(`images/${table}/${id}.${parsed.ext}`);
  await s3().send(
    new PutObjectCommand({
      Bucket: process.env.R2_STATIC_BUCKET,
      Key: key,
      Body: parsed.bytes,
      ContentType: parsed.contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return publicUrl(key);
}
