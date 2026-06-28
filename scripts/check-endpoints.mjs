#!/usr/bin/env node
/**
 * Verifica convenciones OBLIGATORIAS y RECOMENDADAS de los endpoints de
 * `app/api/**`. Cero dependencias (solo Node) — corre en `prebuild` y CI, igual
 * que lo haría una regla de ESLint, pero sin tocar el lockfile (frágil aquí:
 * formato npm 10 de CI vs npm 11 local). Ver docs/guides/documentar-endpoints-openapi.md
 * y la sección "Crear un endpoint" en AGENTS.md / CONTRIBUTING.md.
 *
 * DOS niveles (patrón estándar de linters: error vs warn + allowlist):
 *   - ERROR (rompe CI) — reglas DETERMINÍSTICAS "no sigue el patrón":
 *       · falta el bloque `@swagger`.
 *       · handler NO async (`export function GET` en vez de `export async`).
 *         Los handlers hacen I/O: deben ser async.
 *       · llamadas SÍNCRONAS bloqueantes en el request path (readFileSync,
 *         execSync, *.sync()) → bloquean el event loop.
 *       · `export const maxDuration` → señala I/O largo inline; ese trabajo va a
 *         una cola BullMQ (patrón 202), no a un handler de larga duración.
 *   - WARN (no rompe) — heurísticas con excepciones legítimas:
 *       · mutación (POST/PUT/PATCH/DELETE) sin auth NI rate-limit → posible abuso.
 *       · GET público sin cache (`cached(`/`jsonWithEtag`/`Cache-Control`).
 * Para silenciar un warn legítimo, añade el comentario `// endpoint-check: ok`
 * en el archivo (allowlist inline). Los ERRORES no se pueden silenciar.
 *
 * Uso: `node scripts/check-endpoints.mjs`  (npm run endpoints:check)
 * Sale 1 solo si hay ERRORES (los warns informan, no rompen).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const API_DIR = "app/api";
// Exentos del @swagger: sirven la propia doc, no se documentan a sí mismos.
const SWAGGER_EXEMPT = new Set([
  "app/api/openapi/route.ts",
  "app/api/docs/route.ts",
]);

function findRoutes(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findRoutes(full));
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

const routes = findRoutes(API_DIR);
const errors = [];
const warnings = [];

for (const file of routes) {
  const src = readFileSync(file, "utf8");
  const optOut = src.includes("endpoint-check: ok");

  // --- ERROR: @swagger obligatorio ---
  if (!SWAGGER_EXEMPT.has(file) && !src.includes("@swagger")) {
    errors.push(`${file}: falta el bloque @swagger (OBLIGATORIO).`);
  }

  // --- ERROR: handler NO async ---
  const syncHandler = src.match(
    /export\s+function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/,
  );
  if (syncHandler) {
    errors.push(
      `${file}: handler ${syncHandler[1]} no es async. Usa ` +
        `'export async function ${syncHandler[1]}' (los handlers hacen I/O).`,
    );
  }

  // --- ERROR: llamadas síncronas bloqueantes en el request path ---
  const blocking = src.match(/\b(readFileSync|writeFileSync|execSync|readdirSync|statSync)\b/);
  if (blocking) {
    errors.push(
      `${file}: usa ${blocking[1]} (bloquea el event loop). Usa la variante ` +
        `async (fs/promises) o saca ese trabajo a un worker.`,
    );
  }

  // --- ERROR: maxDuration (I/O largo inline -> debe ir a cola) ---
  if (/export\s+const\s+maxDuration\b/.test(src)) {
    errors.push(
      `${file}: define maxDuration → señala I/O largo inline. Ese trabajo va a ` +
        `una cola BullMQ (encolar → 202 → status-poll), no a un handler largo. ` +
        `Ver worker/sourcesSync.queue.ts como patrón.`,
    );
  }

  if (optOut) continue; // allowlist inline: salta los warns heurísticos

  const hasMutation = /export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)/.test(src);
  const hasGet = /export\s+async\s+function\s+GET/.test(src);
  const hasAuth =
    src.includes("isAdminRequest") ||
    src.includes("isCronRequest") ||
    src.includes("isHospitalSupplyWriteRequest") ||
    src.includes("SupplyWriteRequest");
  const hasRateLimit = src.includes("checkRateLimit");
  const hasCache =
    src.includes("cached(") ||
    src.includes("jsonWithEtag") ||
    src.includes("Cache-Control");

  // --- WARN: mutación sin auth ni rate-limit ---
  if (hasMutation && !hasAuth && !hasRateLimit) {
    warnings.push(
      `${file}: mutación (POST/PUT/PATCH/DELETE) sin auth ni checkRateLimit ` +
        `— riesgo de abuso. Añade checkRateLimit o un gate de auth, o ` +
        `'// endpoint-check: ok' si es intencional.`,
    );
  }

  // --- WARN: GET público sin ninguna estrategia de cache ---
  if (hasGet && !hasCache) {
    warnings.push(
      `${file}: GET sin cache (cached()/jsonWithEtag/Cache-Control) — pega a la ` +
        `DB en cada request. Envuelve en cached()+jsonWithEtag o pon ` +
        `Cache-Control, o '// endpoint-check: ok'.`,
    );
  }
}

if (warnings.length) {
  console.warn(`\n⚠️  ${warnings.length} aviso(s) de convención de endpoints:\n`);
  for (const w of warnings) console.warn(`   - ${w}`);
}

if (errors.length) {
  console.error(`\n❌ ${errors.length} error(es) de endpoint (rompen el build):\n`);
  for (const e of errors) console.error(`   - ${e}`);
  console.error(
    "\nGuía: docs/guides/documentar-endpoints-openapi.md · AGENTS.md (Crear un endpoint)\n",
  );
  process.exit(1);
}

const documented = routes.length - SWAGGER_EXEMPT.size;
console.log(
  `✓ endpoints: ${documented}/${documented} con @swagger (${SWAGGER_EXEMPT.size} exentos)` +
    `${warnings.length ? `, ${warnings.length} aviso(s)` : ", sin avisos"}.`,
);
