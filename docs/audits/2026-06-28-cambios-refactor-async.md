# Cambios — refactor async (request path + colas)

Fecha: 2026-06-28
Rama: `refactor/async-overhaul`
Base: `main` @ 87d93c2
RFC: `docs/rfcs/0003-refactor-async-http-y-colas.md`
Auditoría origen: `docs/audits/2026-06-27-auditoria-pesada.md`

Resumen de TODO lo que cambió en este refactor, fase por fase, con archivos y el
hallazgo del audit que cierra cada cambio. 7 commits, 0 errores de
lint/typecheck, build OK.

---

## Fase 0 — Seguridad (commit c35a5c1)

| Cambio | Archivo | Audit |
|---|---|---|
| `hashIp()` (sha256 + `IP_SALT`); las columnas `ip_hash` dejan de guardar IP cruda | `lib/ratelimit.ts`, `app/api/contact/route.ts`, `app/api/donations/route.ts`, `app/api/reports/[id]/confirm/route.ts` | A-4 / M-7-bis |
| `clientIp()` toma el hop XFF más a la **derecha** (proxy, no cliente) | `lib/ratelimit.ts` | A-6 |
| `TRUSTED_IP_HEADER` deja de ser `x-forwarded-for` (falsificable → anulaba todo el rate-limit) → vacío + comentario | `infra/k8s/secret.example.yaml`, `docker-compose.yml`, `.env.example` | A-6 |
| `/api/patients/search`: rate-limit por IP + búsqueda solo por nombre (no enumerable por cédula/teléfono) | `app/api/patients/search/route.ts`, `lib/hospitals.ts` | C-1 |
| `IP_SALT` documentado | `.env.example`, `infra/k8s/secret.example.yaml` | A-4 |

**Decisión de producto:** los campos `contact`/`notes` de pacientes se MANTIENEN
públicos (las familias optan por ser contactables). Solo se cerró la enumeración.
**No incluido:** A-7 (cola de moderación para "found") — el endpoint ya exige nota
+ foto de prueba; la cola queda como follow-up para no romper el self-service.

## Fase 1 — Request path no bloqueante (commit 1bdbefb)

| Cambio | Archivo | Audit |
|---|---|---|
| `/api/missing`: el `count(*)` exacto sobre 67k+ filas (2.5–5.7s) se acota y corre EN PARALELO con la página (`Promise.all`) | `lib/missing.ts` | R-1 |
| `/api/hub/stats`: 5 COUNT seriales → `Promise.all` | `app/api/hub/stats/route.ts` | M-3 / R-4 |
| `/api/chat` GET: envuelto en `cached()` + `jsonWithEtag()` | `app/api/chat/route.ts` | A-3 |
| `jsonWithEtag`: memoiza `{json, etag}` por referencia (WeakMap) — no re-serializa/hashea por hit | `lib/http.ts` | B-9 |
| hubIngest: enqueue de imágenes en paralelo + contador correcto | `worker/jobs/hubIngest.ts` | B-3 |

## Fase 2 — Índices (commit e1707ad)

| Cambio | Archivo | Audit |
|---|---|---|
| Declarar el unique parcial `(source, external_id)` + migración idempotente con extensiones `pg_trgm`/`unaccent`, `f_unaccent` IMMUTABLE y el índice GIN trigram `idx_missing_search` | `infra/db/schema.ts`, `infra/db/migrations/0004_known_sumo.sql` | A-2 / M-5 |

**Verificado en prod:** todos estos objetos YA existían (creados a mano); la
migración es no-op en prod (`IF NOT EXISTS`) y solo completa un rebuild limpio.

## Fase 4 — Robustez de colas (commit e6d4b80)

| Cambio | Archivo | Audit |
|---|---|---|
| Dead-letter queue: jobs que agotan reintentos → lista Redis capada `mapa:dlq` + alerta de tasa de fallos | `worker/deadletter.ts`, `worker/queues.ts` | M-1 |
| Safety-net de proceso: `unhandledRejection` (log) + `uncaughtException` (exit 1 para reinicio k8s) | `worker/index.ts` | B-1 |
| Hub 429: respeta `Retry-After` (`moveToDelayed` + `DelayedError`) en vez del backoff fijo | `worker/queues.ts` | B-4 |
| `migratePhoto`: ya NO retiene conexión pooleada a través de fetch + R2 PUT; lee en txn corta, I/O sin client, sella con UPDATE guardado atómico | `worker/jobs/migratePhoto.ts` | M-4 |
| `targetPool` max 8→16 (tunable `TARGET_POOL_MAX`) | `worker/db.ts` | M-4 |

## Fase 3 — Sync → cola (commit affb22b) · EL CAMBIO CENTRAL

| Cambio | Archivo | Audit |
|---|---|---|
| Nueva cola `sources-sync` (patrón boahaus: productor + factory de worker en un módulo ligero; lógica pesada lazy-imported) | `worker/sourcesSync.queue.ts` | M-2 |
| Worker + scheduler de sync (cada 10min, `SYNC_SCHEDULERS=0` lo apaga) + DLQ | `worker/index.ts` | M-2 |
| `/api/sync/run`: valida fuente → encola un job por fuente → **202 {jobIds}**. Quitado `maxDuration:300` | `app/api/sync/run/route.ts` | M-2 |
| `/api/sync/cron`: solo encola → 202 (trigger externo/fallback; el primario es el scheduler del worker) | `app/api/sync/cron/route.ts` | M-2 |
| **Nuevo** `GET /api/sync/status?jobId=` (admin): status-poll del job | `app/api/sync/status/route.ts` | M-2 |

El motor `runSyncChunked` (ya chunked + checkpointed) NO se reescribió: se movió
de detrás del handler HTTP a detrás del worker. **No se añadió SSE/event-bus**
(YAGNI: nadie espera el resultado en vivo; el consumidor del sync son las tablas).

**Rollout (importante):** el worker corre 24/7 en k3s y ya tiene `VALKEY_URL` via
`app-env`. No apagar ningún trigger viejo hasta verificar que el scheduler
registra y corre (riesgo: el sync se detendría en silencio).

## Fase 5 — Contrato API (commit da209e8)

| Cambio | Archivo | Audit |
|---|---|---|
| `lib/image.ts`: FUENTE ÚNICA de validación/parseo de data-URIs (reemplaza 5 validadores divergentes); rechaza svg/gif inline | `lib/image.ts`, `lib/store.ts`, `lib/missing.ts`, `app/api/reports/route.ts` | M-6 |
| `nationality` añadido al schema OpenAPI `MissingPerson` | `lib/swagger.ts` | R-6b |
| `/api/hospitals`: default `limit` 500→50 en el route (footgun) | `app/api/hospitals/route.ts` | R-2 |
| `seedHospitalsIfNeeded`: 174 INSERT seriales → UN INSERT multi-fila + promesa in-flight; marca "hecho" solo tras éxito | `lib/hospitals.ts` | A-1 |
| `public/openapi.json` regenerado (38 paths) | `public/openapi.json` | — |

## Fase 5b — Alineación del frontend (commit 447ccde)

Revisión de consumidores tras los cambios de contrato:

| Cambio | Archivo | Motivo |
|---|---|---|
| `/api/hospitals` con `limit=1000` explícito | `app/components/Hospitals.tsx` | el default bajó a 50; la página pública necesita todos |
| Titulares de desaparecidas/encontradas → `/api/missing/stats` (exacto, cacheado) | `app/components/HeroStats.tsx`, `HeroPeopleLinks.tsx`, `PersonsTabs.tsx` | el `total` de la lista ahora está acotado |
| `LIST_COUNT_CAP` 10k→100k | `lib/missing.ts` | que la paginación de FoundPersons alcance todas las filas reales |

`/api/sync/run` desde AdminDashboard no lee el body (solo dispara + refresca), así
que el cambio a 202 es compatible sin tocarlo.

---

## Verificación

- `npm run lint` → 0 errores (19 warnings preexistentes).
- `npm run typecheck` → OK.
- `npm run build` → Compiled successfully.
- `npm run openapi` → 38 paths.

## Fase 6 — Endpoints restantes a async + drenado alineado (añadido)

Tras revisar qué endpoints seguían bloqueando y cómo drena Hermes:

### Cola nueva `maintenance` (geocode + duplicados)

| Cambio | Archivo | Motivo |
|---|---|---|
| Módulo de cola `maintenance` (productor + worker factory, patrón boahaus) | `worker/maintenance.queue.ts` | M-2 |
| `/api/sync/geocode`: corría Nominatim inline (`maxDuration:300`, solo lo llamaba el cron de Vercel) → ahora encola → 202 + scheduler del worker cada 5 min | `app/api/sync/geocode/route.ts` | M-2 |
| `/api/sync/duplicates`: CTE pesado inline (`maxDuration:60`) → POST encola → 202 `{jobId}`; el admin lee el resultado por status-poll | `app/api/sync/duplicates/route.ts` | M-2 |
| `/api/sync/status`: ahora resuelve jobs de ambas colas (`sync-*` y `maint-*`) | `app/api/sync/status/route.ts` | — |
| AdminDashboard "Generar reporte": POST → poll `/api/sync/status` cada 1.5s hasta `completed` (patrón 202+poll de Hermes/boahaus) | `app/admin/AdminDashboard.tsx` | — |

**Polling vs SSE:** geocode no tiene frontend (cron-only, alimenta `geocode_cache`)
→ sin UI. duplicates es el ÚNICO que un humano espera → status-poll (no SSE: una
sola espera puntual, no un stream). sync/run ya refresca el dashboard sin leer el
job. Coherente con el RFC 0003 (SSE solo si hay cliente esperando en vivo; aquí no).

### Drenado alineado (cadena de timeouts tipo Celery/Hermes)

| Cambio | Archivo | Motivo |
|---|---|---|
| `terminationGracePeriodSeconds` 120→240 (> job más largo ~200s) | `infra/k8s/worker-deployment.yaml` | drain |
| `worker.close()` con cap `WORKER_CLOSE_TIMEOUT_MS=210s` (< grace 240s) → sale limpio antes del SIGKILL | `worker/index.ts` | drain |
| `lockDuration=LONG_JOB_LOCK_MS (300s)` en workers de jobs largos (tables, hub-ingest, sources-sync, maintenance) | `worker/queues.ts`, `worker/sourcesSync.queue.ts`, `worker/maintenance.queue.ts` | **bug latente**: el lock default de BullMQ (30s) era < jobs de ~200s → se marcaban "stalled" y se RE-EJECUTABAN en paralelo (equivalente al `visibility_timeout` de Celery) |

Cadena resultante (cada capa > la interna, como Hermes):
`job ~200s < lock 300s` y `close cap 210s < grace 240s < SIGKILL`.

## Fase 7 — Optimización del frontend (redundancias + caché de paginación)

Revisión de uso de endpoints en el frontend: requests duplicadas y UX de páginas.

### Store compartido de stats (patrón dashboard boahaus)

En el home, 3 componentes hacían CADA UNO su propio `fetch /api/missing/stats` +
`setInterval(60s)`: `HeroDesktopNav`, `MobileStickyNav` (ambos de SectionNav) y
`EmergencyApp` (en otras rutas también HeroStats/HeroPeopleLinks/PersonsTabs) →
3-5 requests idénticas + 3-5 timers para el mismo dato.

| Cambio | Archivo |
|---|---|
| `useMissingStats` con `useSyncExternalStore` (forma recomendada React 19; lo que usan SWR/react-query por dentro, sin dependencia nueva). UN poll ref-counted (arranca con el 1er suscriptor, para con el último), pausado con pestaña oculta, con dedup de fetch en vuelo | `app/components/useMissingStats.ts` (nuevo) |
| Migrados al hook compartido | `HeroStats.tsx`, `HeroPeopleLinks.tsx`, `PersonsTabs.tsx`, `SectionNav.tsx`, `EmergencyApp.tsx` |

Resultado: de 3-5 polls simultáneos → **1 solo** por página. EmergencyApp además
deja de pedir stats en su loop de 5s (los counts no necesitan esa frecuencia).

### Caché de paginación (1→2→1 instantáneo)

`MissingPersons` pedía al servidor en cada cambio de página con `cache:no-cache`,
así que volver a una página ya vista esperaba al origen.

| Cambio | Archivo |
|---|---|
| Caché en memoria por sesión de páginas visitadas (clave `status:q:page`); al cambiar de página se muestra la caché AL INSTANTE y se revalida en segundo plano (stale-while-revalidate). Se limpia al cambiar el término de búsqueda | `app/components/MissingPersons.tsx` |

Junto con el fix server-side de Fase 1 (count acotado+paralelo), el cambio de
página deja de sentirse lento: la primera visita es más rápida en el servidor y
las revisitas son inmediatas en el cliente.

### Nota sobre la lentitud 1→2 que reportaste

Medido en prod: el COUNT exacto hoy tarda ~239ms (no los 5.7s del audit; el
estado del dataset/caché cambió). El cap (Fase 1) lo baja a ~83ms. La lentitud
percibida venía sobre todo de **re-fetch sin caché en cada clic** + el reinicio
del polling al cambiar `page`. Fase 1 (servidor) + Fase 7 (caché cliente) lo
atacan por ambos lados.

## Pendiente (documentado, requiere coordinación)

- **R-6a** unificar forma de paginación (`{items, …}` única) — rompe frontend,
  migrar endpoint por endpoint.
- **R-6c** `states: null` en hospitales — poblar o quitar.
- **R-6d** paginar `/api/reports` y `/api/chat` por cursor.
- **R-7** exigir bbox / bajar default en `/api/missing/map` + clustering.
- **A-7** cola de moderación `pending_found` para "encontrada".

Ver `docs/rfcs/0003-refactor-async-http-y-colas.md` §5.
