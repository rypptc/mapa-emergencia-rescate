import { z } from "zod";

/**
 * Validación de entorno en el arranque (fail-fast). Si falta algo crítico, el
 * server NO levanta — mejor que descubrir un undefined en runtime sirviendo a
 * gente en emergencia. Las claves opcionales degradan con gracia (ver notas).
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(8080),

  // DB: Postgres TCP (Hetzner VPS). El proyecto ya NO usa Neon.
  DATABASE_URL: z.string().min(1, "DATABASE_URL es obligatorio"),

  // Valkey: OPCIONAL. Sin esto el rate-limit cae a memoria (degradado, no rompe).
  VALKEY_URL: z.string().optional(),

  // Auth.
  ADMIN_PASSWORD: z.string().optional(),
  CRON_SECRET: z.string().optional(),

  // JWT de la superficie autenticada (api/public/*). Firma HS256. En prod DEBE
  // ser largo (validado abajo). Sin esto en dev, el login/invite no operan.
  JWT_SECRET: z.string().optional(),
  // Vida del access token (segundos). Default 12h (alineado con ResponseGrid).
  JWT_TTL_SECONDS: z.coerce.number().default(43200),
  // Nombre de la cookie httpOnly que lleva el JWT en el navegador.
  AUTH_COOKIE_NAME: z.string().default("mapa_session"),
  // Cookie Secure (HTTPS). En prod SIEMPRE on; en dev local off para http.
  COOKIE_SECURE: z.coerce.boolean().default(false),

  // Invitaciones: base del frontend para construir el link de aceptación.
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  // Caducidad de una invitación (horas).
  INVITE_TTL_HOURS: z.coerce.number().default(72),

  // SMTP para emails de invitación (motor de Argo). OPCIONAL: sin SMTP_HOST el
  // invite devuelve el link en la respuesta (dev) en vez de mandar correo.
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("Mapa Emergencia <noreply@dreamit.software>"),

  // Privacidad: sal para hashear IPs antes de persistir. Sin esto, hashIp lanza.
  IP_SALT: z.string().optional(),
  // Privacidad: secreto HMAC para documentos de pacientes importados. Permite
  // dedup exacta sin guardar cédulas/documentos crudos fuera de staging.
  PATIENT_DOCUMENT_HASH_SECRET: z.string().optional(),

  // Cabecera de IP de confianza. Detrás de Cloudflare debe ser cf-connecting-ip
  // (el cliente NO puede falsificarla). Default a cf-connecting-ip aquí porque el
  // backend SIEMPRE está detrás del LB/Cloudflare en prod.
  TRUSTED_IP_HEADER: z.string().default("cf-connecting-ip"),

  // Cloudflare Turnstile (prueba de humanidad en writes públicos). OPCIONAL:
  // sin TURNSTILE_SECRET_KEY el middleware requireHuman se desactiva (dev local).
  TURNSTILE_SECRET_KEY: z.string().optional(),

  // CORS: orígenes permitidos del frontend (coma-separados). En dev, localhost.
  CORS_ORIGINS: z.string().default("http://localhost:3000"),

  // Colas BullMQ (worker). Opcionales con defaults sanos.
  QUEUE_PREFIX: z.string().default("mapa"),
  QUEUE_REMOVE_ON_COMPLETE: z.coerce.number().default(1000),
  QUEUE_REMOVE_ON_FAIL: z.coerce.number().default(5000),

  // Proxy de analítica OpenPanel (route op/[...op]). Opcionales.
  OPENPANEL_API_URL: z.string().default("https://api.openpanel.dev"),
  OPENPANEL_CLIENT_SECRET: z.string().optional(),

  // OCR/ICR de importación de pacientes (Minimax VL, OpenAI-compatible).
  // DESACTIVADO por defecto: sin MINIMAX_API_KEY el proveedor no se construye y
  // el ingest OCR/ICR sigue respondiendo 501 (sin habilitar auto-aplicación). El
  // token es SOLO server-side: nunca se loguea ni se expone en respuestas. El
  // endpoint, el modelo (VL), el prompt, el máximo de tokens y el timeout son
  // parametrizables para cambiar de modelo sin redeploy.
  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_OCR_BASE_URL: z.string().default("https://api.minimax.io/v1"),
  MINIMAX_OCR_MODEL: z.string().default("MiniMax-M3"),
  MINIMAX_OCR_MAX_TOKENS: z.coerce.number().int().positive().default(2048),
  MINIMAX_OCR_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  MINIMAX_OCR_PROMPT: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("❌ Config de entorno inválida:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

// Fail-fast de seguridad: en prod, un JWT_SECRET ausente o corto es una falla de
// configuración crítica (tokens forjables). Validado en TODOS los envs distintos
// de test para no descubrirlo en runtime sirviendo a gente en emergencia.
if (env.NODE_ENV === "production") {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    console.error("❌ JWT_SECRET es obligatorio y debe tener >=32 caracteres en producción.");
    process.exit(1);
  }
  if (!env.PATIENT_DOCUMENT_HASH_SECRET || env.PATIENT_DOCUMENT_HASH_SECRET.length < 32) {
    console.error(
      "❌ PATIENT_DOCUMENT_HASH_SECRET es obligatorio y debe tener >=32 caracteres en producción.",
    );
    process.exit(1);
  }
  if (!env.COOKIE_SECURE) {
    console.error("❌ COOKIE_SECURE debe estar activo en producción (cookies de sesión sobre HTTPS).");
    process.exit(1);
  }
}

export const corsOrigins = env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
