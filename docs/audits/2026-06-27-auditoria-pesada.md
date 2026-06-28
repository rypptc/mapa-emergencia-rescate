# Auditoría pesada — mapa-emergencia-rescate

Fecha: 2026-06-27
Alcance: superficie HTTP pública/admin (`app/api/**`), capa de datos
(`lib/**`), workers BullMQ (`worker/**`), esquema (`infra/db/schema.ts`) e
infraestructura de despliegue (`infra/k8s`, `infra/tofu`).
Lentes: seguridad, async en el request path, async en workers, performance,
calidad.
Referencias de patrón de casa: `boahaus-backend` (BullMQ) y `clickup-argo`
(vistas async ADRF). Todos los hallazgos abajo están verificados contra el
código; no hay hallazgos inventados.

---

## 1. Resumen ejecutivo

### Veredicto honesto

No es basura. Es un proyecto Next.js 16 con buen gusto arquitectónico en la
mayoría de las decisiones: hay una capa `cached()` + `jsonWithEtag()` aplicada
de forma consistente en casi todas las rutas calientes, un patrón de
allowlisting de columnas (`lib/contact-inbox.ts:48` excluye `ip_hash`), workers
BullMQ con apagado elegante, rate-limit, cache, y migraciones versionadas con
Drizzle. El equipo claramente sabe cuál es el patrón correcto: lo aplica bien en
el 80% de los sitios.

El problema es que el 20% restante son justo los lugares donde más duele, y
varios de ellos son **errores de seguridad reales y explotables hoy**, no
deuda teórica. La narrativa "todo esto es basura" es injusta con el código que
está bien hecho, pero el instinto de que algo huele mal es correcto: hay fugas
de PII médica sin autenticar, un bypass total del rate-limiting por
configuración de despliegue, y al menos dos sitios donde el request path hace
I/O pesado de forma inline cuando este repo **ya tiene** la cola BullMQ para
descargarlo. La buena noticia: como el patrón correcto ya existe en el repo, casi
todos los fixes son "copiar lo que ya haces en la ruta de al lado".

Comparado con la vara de casa: los workers ya siguen el patrón boahaus de
procesos dedicados con drain elegante y colas aisladas por dominio. Lo que falta
es la disciplina boahaus de (a) DLQ + alerting para trabajo crítico, y (b)
mover el I/O de terceros fuera del request path hacia la cola que ya existe.

### Top 5 a arreglar YA

1. **[CRÍTICO] Búsqueda de pacientes pública filtra PII médica.**
   `app/api/patients/search/route.ts:41-53` devuelve cédula (en notas),
   teléfono y notas médicas libres a cualquiera en internet, sin auth, sin
   rate-limit, y con cache de CDN. Permite enumeración por cédula/teléfono
   parcial. Es el peor hallazgo del repo.
2. **[ALTO] Bypass total del rate-limiting por config de despliegue.**
   `infra/k8s/secret.example.yaml:25` pone `TRUSTED_IP_HEADER=x-forwarded-for`,
   que es spoofeable por el cliente. Convierte el brute-force del login admin
   (5/min) en ilimitado y vacía todos los demás límites por IP.
3. **[ALTO] Pacientes por hospital también filtran notas + contacto sin auth.**
   `app/api/hospitals/[id]/patients/route.ts:95-106` ya se renderiza en la UI
   pública. Mismo problema que (1) por enumeración.
4. **[ALTO] IP en crudo guardada en columna llamada `ip_hash`.**
   `app/api/contact/route.ts:57,86` (y donations, y confirm) persisten la IP
   plana. Viola las reglas de privacidad del propio `CLAUDE.md` y es un contrato
   silenciosamente roto.
5. **[ALTO] Cualquiera puede marcar a una persona como "encontrada".**
   `app/api/missing/[id]/found/route.ts:74-136` no tiene auth admin; suprime
   reportes activos del mapa/listado público durante una emergencia. Ataque de
   integridad/censura sobre un dataset de vida o muerte.

Cierra estos cinco antes de cualquier otra cosa. Los tres primeros son fugas de
PII en contexto humanitario; los dos últimos son integridad de datos de vida o
muerte.

---

## 2. Hallazgos por severidad

> Cada hallazgo cita `archivo:línea`, evidencia, impacto y el fix concreto.
> Cuando aplica, se muestra cómo lo hace boahaus/argo o cómo ya lo hace este
> mismo repo en otra ruta.

### CRÍTICO

#### C-1. Búsqueda pública de pacientes filtra PII médica (cédula, teléfono, notas) y permite enumeración

- **Archivo:** `app/api/patients/search/route.ts:41-53`
- **Evidencia:** El handler `GET` no tiene `isAdminRequest` ni rate-limit; llama
  `searchPatients(q, limit)` y devuelve filas `HospitalPatient` crudas. El query
  (`lib/hospitals.ts:425-429`) hace `LOWER(p.notes)`, `LOWER(p.contact)` y un
  `REGEXP` sobre notas con dígitos despojados (match con ≥4 dígitos) —
  enumerable por cédula o teléfono parcial. `rowToPatient`
  (`lib/hospitals.ts:516-533`) devuelve `notes` y `contact` verbatim, y
  `lib/swagger.ts:138-139` los expone en el DTO público. Cache de CDN
  `s-maxage=5, swr=30` (`route.ts:6-7`). Lo consume un componente público,
  `app/components/Hospitals.tsx:111`.
- **Impacto:** Cualquiera en internet puede buscar personas hospitalizadas por
  cédula o teléfono parcial y cosechar cédula, teléfono y notas médicas en texto
  libre. En contexto humanitario/conflicto esto es riesgo de seguridad directo
  (re-identificación, targeting de sobrevivientes). El edge-cache puede además
  servir resultados a otros clientes.
- **Fix:** Tratar contacto/notas/cédula como sensibles. O (a) cerrar el endpoint
  detrás de `isAdminRequest` como las otras lecturas admin, o (b) quitar `notes`
  y `contact` del DTO público y eliminarlos de los campos buscables, devolviendo
  solo nombre/edad/estado/hospital. Añadir `checkRateLimit(clientIp(request))`
  en cualquier caso.
- **Patrón de casa:** Este mismo repo ya cierra lecturas sensibles con
  `isAdminRequest` (`app/api/admin/data`, `admin/contact`, `admin/donations`) y
  usa un `listColumns` restringido para no exponer `ip_hash`
  (`lib/contact-inbox.ts:48`). Aplica esa disciplina de allowlist de DTO aquí.
  Es la misma filosofía de boahaus de no serializar el objeto completo hacia la
  respuesta pública.

---

### ALTO

#### A-1. `seedHospitalsIfNeeded` inserta ~174 filas seed una por una (N+1 secuencial) en la primera request de hospitales

- **Archivo:** `lib/hospitals.ts:37-63` (invocado desde `listHospitals:166`,
  `getHospital:261`, `listStates:243`, `searchPatients:384`)
- **Evidencia:** `for (const h of hospitalsSeed) { try { await getDb().insert(hospitals).values({...}).onConflictDoNothing(...); } catch {} }`.
  Son 174 filas (`lib/data/hospitals-seed.json`), no ~100. El driver de prod por
  defecto es `neon-http` (`lib/drizzle.ts:27,50`), así que cada INSERT es un hop
  HTTPS separado. `_seedDone` se pone `true` en la línea 29 **antes** de que el
  loop termine.
- **Impacto:** La primera request a cualquier ruta de hospitales (un GET
  público) dispara 174 round-trips secuenciales y bloquea hasta terminar. Una
  segunda request concurrente lee una tabla a medio sembrar (race no destructivo
  por `onConflictDoNothing`, pero real). El flag es por instancia, así que cada
  instancia serverless fría re-paga el costo. El wrapper `cached(key, 10_000)` de
  la ruta no mitiga: el seed corre dentro de `listHospitals` en el primer miss.
- **Fix:** Reemplazar el loop por un único INSERT multi-fila
  `... ON CONFLICT DO NOTHING` (el mismo patrón que `upsertExternalMissingBatch`
  ya usa en `lib/missing.ts:880-895`), o mejor: sacar el seeding del request path
  hacia una migración/worker (este repo ya migra hospitales vía
  `worker/jobs/migrateTable.ts`). Poner `_seedDone = true` solo tras éxito, o
  guardar con una promesa in-flight compartida.
- **Patrón de casa:** boahaus "Sync/seed confinado a paths de worker — nunca en
  el request path" (`fileFallback.ts:30-51`, `ema.postSession` dentro de un
  job). El batch-insert refleja el propio `upsertExternalMissingBatch` del repo.

#### A-2. El índice trigram `idx_missing_search` y `f_unaccent` se referencian en código pero no se crean en ningún lado — cada `?q=` es un seq scan

- **Archivo:** `lib/missing.ts:106-121, 313-321`
- **Evidencia:** `accentSearchReady()` prueba
  `to_regclass('public.idx_missing_search')`; en su ausencia el WHERE cae a
  `lower(name||' '||last_seen||' '||coalesce(description,'')) ILIKE '%term%'`. Un
  grep en `infra/db/migrations/**`, `scripts/**` y `*.sql` no encuentra
  `CREATE INDEX idx_missing_search`, ni `CREATE EXTENSION pg_trgm/unaccent`, ni
  la función `f_unaccent`. La tabla `missing_persons`
  (`infra/db/schema.ts:105-113`) solo declara `idx_missing_status_created`,
  `idx_missing_map_coords`, `idx_missing_photo_pending`.
- **Impacto:** El fast-path acento-insensible está muerto en prod:
  `accentSearchReady()` devuelve siempre `false` y cada búsqueda corre un ILIKE
  con wildcard inicial sobre una expresión concatenada — inindexable, forzando
  un seq scan de `missing_persons` por término (ANDeados). Es un endpoint público
  sin auth donde cada búsqueda dispara un seq scan (amplificación
  request-barata → query-cara). El comentario "el índice GIN puede usar"
  (líneas 99-101, 289) es falso tal como está escrito. El cache de 30s solo
  colapsa queries idénticas repetidas; `SEARCH_COUNT_CAP=500` acota la subquery
  de count.
- **Fix:** Añadir una migración que cree:
  `CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS unaccent;`
  un wrapper `IMMUTABLE f_unaccent(text)`; y
  `CREATE INDEX idx_missing_search ON missing_persons USING gin (f_unaccent(name||' '||last_seen||' '||coalesce(description,'')) gin_trgm_ops)`.
  Per `CLAUDE.md`, exprésalo en `infra/db/schema.ts` con el escape `sql\`...\``
  de drizzle y luego `db:generate` (el builder no expresa un índice GIN de
  expresión).

#### A-3. El GET de chat se salta el micro-cache en proceso Y el path ETag/304 — cada poll pega a Postgres y manda el body completo

- **Archivo:** `app/api/chat/route.ts:83-95`
- **Evidencia:** El GET llama `listMessages(...)` directo y devuelve
  `NextResponse.json({messages,...}, {headers: LIST_CACHE_HEADERS})`. No lo
  envuelve en `cached()` ni usa `jsonWithEtag()`, a diferencia de
  `/api/reports`, `/api/missing`, `/api/missing/map` y `/api/hospitals`, que
  hacen ambas. `FETCH_LIMIT = 200` (`lib/chat.ts:21`). Headers de polling
  (`s-maxage=3, swr=20`).
- **Impacto:** Chat es un endpoint polleado. Sin `cached()` cada instancia corre
  la query de 200 mensajes en cada miss en vez de una por ventana de TTL; sin
  `jsonWithEtag` no hay corto-circuito 304, así que datos sin cambios se
  re-serializan y re-mandan (~200 mensajes) en cada poll. Es el único path de
  lectura caliente que perdió ambas optimizaciones que el resto del código
  aplica.
- **Fix:** Reflejar las otras rutas:
  `const messages = await cached(\`chat:${roleFilter ?? ''}\`, 3000, () => listMessages(...)); return jsonWithEtag(request, {messages, persistent: isPersistent()}, LIST_CACHE_HEADERS);`
- **Patrón de casa:** El combo `cached()` + `jsonWithEtag()` ya está en
  `app/api/reports/route.ts:57-62` y `app/api/missing/route.ts:136-152`.

#### A-4. IP del cliente en crudo guardada en columna llamada `ip_hash` (fuga de PII, viola reglas de privacidad del proyecto)

- **Archivo:** `app/api/contact/route.ts:57,86`
- **Evidencia:** `const ip = clientIp(request); ... await createContactMessage({ ...parsed, ipHash: ip });`.
  `clientIp()` (`lib/ratelimit.ts:42`) devuelve la IP en texto plano. Mismo
  patrón en `app/api/donations/route.ts:116,141` y en `confirmReport` vía
  `app/api/reports/[id]/confirm/route.ts:52,64` → `report_confirmations.ip_hash`
  (`lib/store.ts:186-187`). No hay `createHash`/`sha256` en el path.
- **Impacto:** El esquema y los nombres de columna anuncian IPs hasheadas
  (`ip_hash`) pero persisten IPs planas. `CLAUDE.md` prohíbe explícitamente
  guardar PII en un dataset humanitario; un dump/leak expondría la IP de cada
  persona que reportó un desaparecido, donó o confirmó un rescate. Es además una
  violación de contrato silenciosa: el nombre de columna miente. Mitigante: ya se
  excluye de las respuestas de lista (`lib/contact-inbox.ts:48`), así que es fuga
  at-rest, no expuesta por request normal — por eso ALTO y no CRÍTICO.
- **Fix:** Hashear antes de guardar. Centralizar como `hashIp(request)` en
  `lib/ratelimit.ts`:
  `createHash('sha256').update(ip + IP_SALT).digest('hex')`. Añadir `IP_SALT` a
  `.env.example`. Aplicar a los tres call sites. `lib/http.ts` ya usa
  `createHash` para ETags — reusar. Rotar/backfill filas existentes si hay datos
  reales.

> Nota: este hallazgo y el M-7 ("ipHash guarda IP cruda") describen el mismo
> defecto raíz desde dos lentes (seguridad/calidad). Un solo fix
> centralizado (`hashIp`) resuelve ambos.

#### A-5. El GET público de pacientes por hospital devuelve notas médicas + contacto a cualquiera

- **Archivo:** `app/api/hospitals/[id]/patients/route.ts:95-106`
- **Evidencia:** El GET no tiene auth (solo `force-dynamic`) y devuelve
  `{ patients, hospital }` donde los pacientes son filas `HospitalPatient`
  completas con `notes` (texto libre, hasta 600 chars) y `contact` (teléfono,
  120 chars) — `rowToPatient` (`lib/hospitals.ts:516-533, 557-558`). La UI
  pública lo renderiza directo: `app/components/Hospitals.tsx:842` y
  `app/components/HospitalDetailView.tsx:55` muestran `patient.contact` y
  `patient.notes` a cualquier visitante.
- **Impacto:** Cualquiera puede listar los pacientes de cada hospital con su
  teléfono y notas médicas. Combinado con C-1 es exposición masiva de PII de
  heridos/desplazados. No es solo accesible por API: ya está renderizado en uso
  normal del producto.
- **Fix:** Definir un DTO público de paciente que omita `contact` y `notes` (o
  que generalice `condition`), y devolver el registro completo solo en lecturas
  admin-autenticadas. Mantener el POST de creación como está, pero nunca devolver
  `contact`/`notes` en endpoints de lista públicos.
- **Patrón de casa:** Reflejar `listColumns` de `lib/contact-inbox.ts` que
  excluye deliberadamente `ip_hash` de la salida de lista.

#### A-6. El despliegue pone `TRUSTED_IP_HEADER=x-forwarded-for`, haciéndolo spoofeable y anulando todo el rate-limiting por IP

- **Archivo:** `infra/k8s/secret.example.yaml:25` (también el ejemplo `kubectl`
  línea 8 y `docker-compose.yml:39`)
- **Evidencia:** `stringData` pone `TRUSTED_IP_HEADER: "x-forwarded-for"`.
  `clientIp()` (`lib/ratelimit.ts:43-47`) lee ese header y toma `split(",")[0]`
  (el valor más a la izquierda) — exactamente lo que `lib/ratelimit.ts:33-40`
  advierte que es controlable por el atacante porque un proxy **prepende** a XFF.
  `deployment.yaml:48-49` carga `app-env` vía `envFrom`, así que es el valor real
  en runtime. No existe ningún ingress que strippee/sobrescriba XFF (traefik
  deshabilitado, Hetzner LB con `uses-proxyprotocol=false`).
- **Impacto:** Un atacante manda `X-Forwarded-For: <random>` en cada request y
  obtiene un bucket de rate-limit fresco cada vez, saltándose la protección
  brute-force del login admin (`app/api/admin/login/route.ts:58`, límite 5/min),
  los límites de spam de report/missing, y el límite de marcar-encontrada. La
  contraseña admin se vuelve brute-forceable.
- **Fix:** No confiar en el XFF más a la izquierda. Poner `TRUSTED_IP_HEADER` a
  un header que tu ingress/LB controle y sobrescriba, y que `clientIp` tome el
  hop confiable más a la **derecha**, no el de la izquierda. Si está detrás del
  Hetzner LB, usar el header del LB y strippear el XFF entrante en el ingress.
- **Patrón de casa:** `lib/ratelimit.ts` ya documenta la intención correcta (usar
  un header que TU proxy ponga); el manifiesto contradice el código — alinea el
  manifiesto.

#### A-7. Cualquiera puede marcar a cualquier desaparecido como "encontrado", suprimiéndolo del listado/mapa público

- **Archivo:** `app/api/missing/[id]/found/route.ts:74-136`
- **Evidencia:** `POST /api/missing/{id}/found` no requiere auth admin — solo
  `checkRateLimit(found:ip, 2)`. Llama `markMissingFound` que hace
  `UPDATE ... SET status='found' WHERE id=... AND status='active'`
  (`lib/missing.ts:506-511`). El listado por defecto
  (`app/api/missing/route.ts:124-125`, "las localizadas se ocultan") y el mapa
  (`lib/missing.ts:700`, `status='active'`) ocultan a esa persona. La
  recuperación es asimétrica: `restoreMissing` solo está expuesto vía
  `app/api/missing/[id]/restore/route.ts:42`, que requiere `isAdminRequest`.
- **Impacto:** Un actor malicioso puede resolver en masa reportes activos
  (2 por IP/min, y por el bug A-6 efectivamente ilimitado), quitando
  desaparecidos del tablero público durante una emergencia — ataque de
  integridad/censura sobre un dataset de vida o muerte. El registro no se borra
  (queda nota/foto de resolución y es restaurable), pero solo un admin puede
  restaurar, así que el daño requiere limpieza manual.
- **Fix:** Es una acción mutante sobre un registro de vida o muerte por usuarios
  anónimos por diseño (auto-servicio de la familia), así que añadir anti-abuso
  más fuerte: requerir validación de la foto de prueba, loguear quién/cuándo, y
  considerar una cola de moderación (`status='pending_found'`) que un admin
  confirme antes de ocultar, en vez de ocultar de inmediato.
- **Patrón de casa:** `reports/[id]/confirm` y el flujo admin de restore ya
  muestran que el proyecto distingue transiciones públicas vs admin — aplica el
  mismo patrón "el público propone, el admin dispone" a `found`. Es el mismo
  patrón de argo de transiciones de estado mediadas por la capa de servicio.

---

### MEDIO

#### M-1. Sin dead-letter queue ni alerting de fallos — los jobs fallidos solo sobreviven como un contador `removeOnFail`

- **Archivo:** `worker/queues.ts:29-30, 238-242`
- **Evidencia:** `REMOVE_ON_FAIL=5000` + `w.on('failed', console.error)`. Tras
  agotar intentos, un job vive solo en el set `failed` (acotado a 5000) y se
  loguea por consola. No hay DLQ, ni replay, ni alerta. `enqueue.ts:58-66`
  inspecciona `q.getFailed()` pero SOLO para la cola `tables` durante el producer
  one-shot; los fallos de `photos`/`hub-ingest`/`hub-images` nunca se exponen así.
- **Impacto:** En una corrida de 26k fotos + ingesta continua del hub, más de
  5000 fallos permanentes pueden rodar fuera del set. Sin embargo, hay
  recuperación por rescan: re-correr el producer re-encola fotos via
  `photo_migrated_at IS NULL` (`enqueue.ts:82`), y el reconcile cada 6h re-encola
  imágenes de hub (`hubIngest.ts:117-118,173-176`). Así que el defecto real es
  **observabilidad/alerting**, no pérdida irreversible: los operadores no pueden
  ver fácilmente QUÉ registros fallaron sin raspar logs, y no hay alerta de tasa
  de fallos.
- **Fix:** Añadir un DLQ: en el `failed` final
  (`job.attemptsMade >= job.opts.attempts`), empujar
  `{queue, jobId, data, reason}` a una cola `dead-letter` o tabla Postgres para
  inspección/replay; emitir alerta/métrica sobre tasa de fallos. Reflejar la
  ruidosidad de `getFailed()` de `enqueue.ts` para TODAS las colas, no solo
  `tables`.
- **Patrón de casa:** boahaus lista "No dead-letter queue... Para trabajo
  sensible a crisis un DLQ + alerting es la vara" como antipatrón a evitar. mapa
  es explícitamente crisis-sensible (`CLAUDE.md`) pero no tiene DLQ — peor que la
  vara declarada.

#### M-2. Endpoints de sync hacen I/O HTTP multi-página de terceros inline en el request path (hasta 300s) en vez de encolar

- **Archivo:** `app/api/sync/run/route.ts:104-113` y
  `app/api/sync/cron/route.ts:64`
- **Evidencia:** `export const maxDuration = 300; ... const results = chunk ? await runAllSourcesChunked(...) : await runAllSources(...)`.
  Estas (`lib/sync/engine.ts:113-130, 269-288`) iteran cada fuente y por fuente
  llaman `adapter.fetchAll/fetchPage` (fetch a feeds externos) +
  `upsertExternalMissingBatch`, con `await sleep(200ms)` entre páginas
  (`engine.ts:239`) y un presupuesto de 200s (`engine.ts:21`). El handler HTTP
  mantiene la conexión abierta toda la corrida.
- **Impacto:** Es el anti-patrón sync-over-async que boahaus marca. El cron de
  Vercel dispara cada 10 min (`vercel.json`) y retiene una función serverless
  hasta 300s; un `/api/sync/run` manual bloquea la conexión del caller por
  minutos. Matiz: el cron usa `runAllSourcesChunked`, que está deliberadamente
  acotado (guard `Date.now() - startedAt < timeBudgetMs`, cap de 50
  páginas/corrida, checkpointing por cursor que persiste progreso al timeout) —
  así que el cron NO pierde progreso silenciosamente. El path realmente
  ilimitado es `/api/sync/run` (admin-only, manual). Solo hay 2 fuentes
  registradas. Por eso MEDIO, no crítico.
- **Fix:** Descargar a la cola BullMQ que YA EXISTE en este repo.
  `worker/queues.ts` ya define una cola `hub-ingest` con rate-limit
  (`HUB_INGEST_RATE_MAX 100/60s`), un job `hubIngest`
  (`worker/jobs/hubIngest.ts`), workers con drain elegante (`worker/index.ts`) y
  un helper de encolado (`worker/enqueue.ts`). Añadir una función de encolado
  para el sync de fuentes externas (espejo de `enqueueTable`/`enqueuePhoto`) con
  `jobId` determinístico (p. ej. `sync-<sourceId>-<window>`, usando `-` no `:`),
  que los handlers cron/run encolen un job por fuente y devuelvan `202`
  `{ok:true, jobIds}` de inmediato, y mover la ejecución a un processor del
  worker.
- **Patrón de casa:** boahaus "HTTP handler encola job, devuelve jobId
  inmediatamente (estilo 202)" (`skincare-product.controller.ts:45-90`) y la nota
  de antipatrón sobre `runJobType.ts:84-98` (bloquear el request HTTP toda la
  duración del job). Ver §3 para la comparación detallada.

#### M-3. `hub/stats` corre 5 COUNT independientes en secuencia dentro de un for-loop (waterfall por request)

- **Archivo:** `app/api/hub/stats/route.ts:72-94`
- **Evidencia:** `for (const { type, table, hasPhoto } of TABLES) { ... const res = await db.execute(sql\`SELECT count(*)::int ... FROM ${sql.raw(table)}\`); byType.push(...); }`
- **Impacto:** Los cinco counts son totalmente independientes pero corren uno tras
  otro, así que la latencia total es la SUMA de cinco round-trips en vez del MAX.
  En `neon-http` cada `execute()` es un hop HTTPS, así que es ~5x la latencia
  necesaria. Está envuelto en `cached(30s)` (línea 69) y es admin-only, así que
  solo el miss/refresh paga el costo serial — por eso MEDIO.
- **Fix:** Fan-out con `Promise.all`:
  `const byType = await Promise.all(TABLES.map(async ({type,table,hasPhoto}) => { const res = await db.execute(...); return {...}; }));` y computar el total con `reduce`.
- **Patrón de casa:** boahaus `getProductCollection/getProductDetail` "fan out
  reads con Promise.all" (`skincare-product.controller.ts:303-308`). El mismo
  patrón ya se usa correctamente en este repo en `app/api/admin/data/route.ts:85`,
  `donations/route.ts:87`, `hospitals/route.ts:121`, `admin/contact/route.ts:92`
  — `hub/stats` es el outlier.

#### M-4. El pool del target del worker (max 8) está sobre-suscrito por una concurrencia combinada de ~22

- **Archivo:** `worker/db.ts:22`; `worker/queues.ts:203-230`
- **Evidencia:** `_target = new Pool({max:8})`. `createWorkers` usa
  `PHOTOS_CONCURRENCY=8`, `HUB_IMAGE_CONCURRENCY=8`, `HUB_INGEST_CONCURRENCY=2`,
  `TABLES_CONCURRENCY=4` — suma 22, y los cuatro processors llaman
  `targetPool()`. `migratePhoto.ts:73-132` retiene un client a través de
  `BEGIN .. fetchExternal (99) .. putObject R2 (125) .. COMMIT`.
- **Impacto:** Hasta 22 jobs concurrentes contienden por 8 conexiones. Peor: el
  job de fotos retiene un client pooleado a través de un fetch de red + R2 PUT
  dentro de una transacción, así que la conexión queda fijada por todo el
  round-trip de I/O. Bajo carga esto inanicia el pool. (Corrección al hallazgo
  original: solo `migratePhoto` fija conexión a través de I/O de red;
  `upsertBatch` solo hace INSERTs dentro de la txn, y `hubImage` usa
  `pool.query()` sin retener client.)
- **Fix:** Subir `max` a ≥ suma de concurrencias que pegan al DB (o pools
  separados por cola), y/o mover el R2 PUT/fetch externo FUERA de la transacción
  DB: claim+stamp en una txn corta, hacer el I/O sin retener client, luego una
  segunda txn corta para escribir la URL.

#### M-5. El upsert `ON CONFLICT (source, external_id)` depende de un índice único compuesto que no está en el esquema

- **Archivo:** `lib/missing.ts:885`; `infra/db/schema.ts:105-113`
- **Evidencia:** `upsertExternalMissingBatch` construye
  `INSERT ... ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL`.
  El esquema de `missingPersons` define `idx_missing_status_created`,
  `idx_missing_map_coords`, `idx_missing_photo_pending` — pero NINGÚN índice
  único en `(source, external_id)`. Las cuatro migraciones confirman lo mismo. El
  comentario en `lib/missing.ts:801-802` ("la unicidad es por (source,
  external_id) — ver índice compuesto en infra/db/schema.ts") es falso.
- **Impacto:** `ON CONFLICT` requiere un índice/constraint único que coincida como
  árbitro. Si el índice único parcial falta en prod, el upsert por lote lanza
  (atrapado y contado como `result.errors += chunk.length` en la línea 893,
  descartando silenciosamente todo el lote). Como es el único path de escritura
  del sync externo, un árbitro ausente haría que cada lote falle y el feed entero
  falle en silencio.
- **Fix:** Añadir el índice único parcial a `infra/db/schema.ts`:
  `uniqueIndex('idx_missing_source_extid').on(t.source, t.externalId).where(sql\`external_id IS NOT NULL\`)`
  y generar la migración, igualando el predicado del `ON CONFLICT` exactamente
  (un índice único plano NO sirve como árbitro de un `ON CONFLICT` con predicado
  `WHERE`). También exponer los errores de upsert en vez de tragar lotes enteros.

#### M-6. Cinco validadores/parsers de data-URI de imagen divergentes — mismo trabajo, allowlists inconsistentes

- **Archivo:** `lib/missing.ts:184` (y `lib/store.ts:23,168`,
  `lib/missing.ts:574`, `app/api/reports/route.ts:107`, `lib/r2.ts:61`)
- **Evidencia:** El regex de validación de escritura
  `/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/` está duplicado en
  `lib/store.ts:23` y `lib/missing.ts:184`. `app/api/reports/route.ts:107` usa
  una variante MÁS DÉBIL `/^data:image\/(jpeg|png|webp);base64,/` (sin `$`, sin
  charset). Los decoders de lectura usan una TERCERA/CUARTA forma
  `/^data:(image\/[a-zA-Z+]+);base64,(.+)$/` (`lib/store.ts:168`,
  `lib/missing.ts:574`) que acepta CUALQUIER subtipo (gif, svg+xml). `lib/r2.ts:61`
  tiene una QUINTA forma gateada por un set `ALLOWED_MIME`.
- **Impacto:** El trust boundary se aplica de forma inconsistente: reports acepta
  data URLs con basura al final, y los endpoints que sirven fotos decodifican y
  devuelven `image/svg+xml` (vector de XSS si se sirve inline). Matiz: hoy todos
  los paths de escritura fijan el subtipo a jpeg/png/webp antes de almacenar, así
  que el XSS es latente, no explotable hoy. Es defense-in-depth +
  mantenibilidad, no XSS vivo — por eso MEDIO.
- **Fix:** Un módulo: `lib/image.ts` que exporte `isAllowedImageDataUrl(s)` y
  `parseImageDataUri(s)` respaldados por un único set `ALLOWED_MIME` (reusar
  `parseDataUri` de `lib/r2.ts`). Reemplazar los cinco sitios. Que el decoder de
  lectura rechace MIME no permitido y nunca sirva svg inline (añadir
  `Content-Disposition`).

#### M-7. El rate limiter en memoria es por-pod pese a despliegue multi-pod en k3s y un Valkey provisionado

- **Archivo:** `lib/ratelimit.ts:1`
- **Evidencia:** `checkRateLimit` respalda en un `const memoryHits = new Map()`
  local al proceso. El comentario solo menciona "serverless... por instancia".
  Pero `infra/k8s/deployment.yaml:21` pone `replicas: 2`, `next.config.ts:19-22`
  menciona "los 2 pods" y "no hay sticky sessions en el LB", e
  `infra/tofu/valkey.tf:4` provisiona Valkey (`worker/redis.ts` ya cablea
  ioredis con INCR/EXPIRE).
- **Impacto:** Con N pods y sin sticky sessions, el límite efectivo es N× el
  configurado y se resetea en cada restart/scale. La protección anti-abuso en
  `/api/missing`, `/api/contact` (límite 3), `/api/donations` (límite 5) es
  bastante más débil de lo que los números del código implican.
- **Fix:** Respaldar el limiter con el Valkey ya provisionado (`worker/redis.ts`
  ya cablea ioredis) usando `INCR`+`EXPIRE` por clave; mantener el `Map` solo
  como fallback de dev sin Redis. Actualizar el comentario para dejar de afirmar
  serverless-only.

#### M-8. El contacto del reportante (teléfono/email) se expone en endpoints de desaparecidos totalmente públicos

- **Archivo:** `lib/missing.ts:164` (`rowToPerson`) y
  `app/api/missing/route.ts:142-150`
- **Evidencia:** El DTO `MissingPerson` incluye `contact`
  (`lib/missing.ts:26,163`) y lo devuelve sin auth `GET /api/missing` (cache de
  CDN) y los endpoints por registro. El schema swagger `MissingPerson` también
  anuncia `contact` (`lib/swagger.ts:80`).
- **Impacto:** El campo `contact` es lo que el reportante tecleó (a menudo un
  teléfono/email personal de la familia). Publicarlo en una API pública cacheada
  permite a scrapers cosechar contactos de familias vulnerables a escala. Matiz:
  el contacto se renderiza intencionalmente por tarjeta en la UI (`tel:` links en
  `MissingPersons.tsx`, `MissingPersonDetail.tsx`), así que no es una fuga
  accidental — el riesgo incremental real es el harvesting masivo vía la API
  cacheada sin rate-limit en el GET. La remediación es una decisión de producto,
  no un bug claro.
- **Fix:** Decidir deliberadamente si `contact` debe ser público. Si el producto
  necesita un canal de contacto, gatearlo (admin-only, o click-to-reveal con
  rate-limit/captcha) y omitirlo de los DTOs de lista bulk + mapa. Como mínimo,
  quitarlo del endpoint de lista cacheado.
- **Patrón de casa:** El DTO de mapa (`MissingMapMarker`, `lib/missing.ts:39-49`)
  ya omite `contact` — extender ese patrón de exposición mínima al DTO de lista.

> M-7-bis. `ipHash` guarda IP cruda (lente de calidad de A-4): mismo defecto,
> mismo fix centralizado `hashIp`. Aplicar también a donations
> (`app/api/donations/route.ts:141` → `lib/donations.ts:93`).

---

### BAJO

Estos son hardening/limpieza de bajo impacto. Lista compacta con `archivo:línea`,
el defecto y el fix.

- **B-1. Sin red de seguridad a nivel de proceso (`unhandledRejection` /
  `uncaughtException`) en ningún entrypoint de worker.** `worker/index.ts:33-34`
  (también `enqueue.ts:127`, `hub-backfill.ts:50`) solo cablean SIGTERM/SIGINT.
  Impacto real bajo: BullMQ atrapa los throws de processors y los workers cablean
  listeners `failed`/`error` (`queues.ts:238-241`); el heartbeat ya tiene
  try/catch (`redis.ts:82-84`); los jobs son idempotentes con reintentos. *Fix:*
  añadir `process.on('unhandledRejection', ...)` que loguee fuerte en
  `worker/index.ts`. Defense-in-depth, no pérdida de datos.

- **B-2. El INSERT por lote en `migrateTable` puede exceder el límite de 65535
  bind-params de Postgres.** `worker/jobs/migrateTable.ts:16,135-147`: `BATCH=500`
  y un solo INSERT con `cols.length * rows.length` placeholders. `missing_persons`
  tiene 22 columnas (no ~50), así que el peor caso actual es 500×22=11,000 — ~17%
  del límite. Latente: se necesitaría una tabla de >131 columnas o ~6× el BATCH
  para romperlo. *Fix:*
  `const rowsPerInsert = Math.max(1, Math.floor(60000 / cols.length))` y chunkear,
  o `assert cols.length*BATCH < 65535` al inicio del job.

- **B-3. Awaits seriales donde aplica `Promise.all`: loop de enqueue de imágenes
  en hubIngest.** `worker/jobs/hubIngest.ts:173-176`:
  `for (const hubId of pendingPhoto) await enqueueImage(...)` serialmente, cada
  uno un round-trip a Redis independiente. *Fix:*
  `await Promise.all(pendingPhoto.map((id) => enqueueImage(type, id)))` **y**
  `res.imagesQueued += pendingPhoto.length;` (el fix debe actualizar el contador,
  que el loop original incrementaba). Impacto bajo: el `INTER_PAGE_DELAY_MS`
  (250ms) entre páginas domina el wall-clock. *Patrón de casa:* boahaus "fan out
  reads con Promise.all".

- **B-4. El `retry-after` del hub en un 429 se computa y se descarta — el backoff
  ignora la señal del servidor.** `worker/hub/config.ts:164-169` parsea
  `retry-after` en `err.retryAfter` pero nada lo consume; BullMQ aplica su backoff
  exponencial estático (`queues.ts:131 delay:10_000`). *Fix:* en el processor,
  leer `err.retryAfter` y `await job.moveToDelayed(Date.now()+retryAfter*1000)` o
  lanzar `DelayedError`. Acotado por el limiter (100/60s); peor caso pierde una
  página de un ciclo (recuperable).

- **B-5. El fallo de registro de schedulers se traga a un log; los schedulers
  pueden nunca arrancar en silencio.** `worker/index.ts:16-20`:
  `registerHubSchedulers().catch((err)=>console.error(...))` — sin retry, sin
  señal de unhealthy. `worker-deployment.yaml` no tiene liveness/readiness probe,
  así que un pod que falló el registro se ve "Running" mientras no hace
  federación (incremental cada 5min + reconcile cada 6h). *Fix:* reintentar con
  backoff, o fallar el proceso (que k8s reinicie) si `HUB_SCHEDULERS` está on y
  el registro falla tras N intentos; como mínimo, exponer vía readiness/liveness.
  *Patrón de casa:* boahaus eventBus es "best-effort + ruidoso-en-cero" — el de
  mapa es best-effort pero no ruidoso/observable.

- **B-6. `hub-backfill`/`enqueue` cierran Redis con `disconnect()` y luego
  `process.exit` — abrupto.** `worker/hub-backfill.ts:42-47`,
  `enqueue.ts:117-124`: `disconnect()` corta el socket sin el handshake QUIT.
  Impacto trivial: `releaseLock` ya se awaitea, el lock expira por TTL, y la
  rejection del heartbeat severido se traga en un catch vacío
  (`redis.ts:82-84`). *Fix:* `await getRedis().quit()` en vez de `disconnect()`.
  Preferencia estilística para scripts one-shot.

- **B-7. `incrementPsychologyHelpClick` emite dos statements DB secuenciales por
  POST donde basta un CTE.** `lib/click-counters.ts:30-58`: un INSERT
  ON CONFLICT DO NOTHING (round-trip 1) precede al CTE de dedup/increment
  (round-trip 2). Bajo impacto: rate-limit 20/min/IP **y** deduplicado por IP, así
  que dispara raro. *Fix (con cuidado):* plegar el INSERT base en el mismo CTE NO
  es seguro ingenuamente — los CTEs que modifican datos comparten el snapshot de
  inicio de statement, así que el `UPDATE` no vería la fila recién insertada por
  un CTE hermano y el primer increment se perdería. Usar `RETURNING` del INSERT
  para conducir el increment, o dejarlo como está.

- **B-8. El proxy del script de OpenPanel fetchea el JS upstream completo y
  recomputa un md5 en cada GET.** `app/api/op/[...op]/route.ts:109-119`:
  `createHash("md5").update(SCRIPT_URL + script)` por request, en un route
  `force-dynamic`. Bajo impacto: `Cache-Control: public, max-age=86400, swr` hace
  que clientes/CDN caché ~24h, así que el proxy rara vez se re-pega; md5 sobre un
  script de pocos KB es sub-ms. *Fix:* reenviar los validadores upstream
  (`res.headers.get('etag')`) o memoizar el hash a nivel de módulo.

- **B-9. `jsonWithEtag` hace `JSON.stringify` + sha1 síncronos del payload
  completo en cada GET de hot-path.** `lib/http.ts:18-19` (usado por reports,
  missing, missing/map, missing/stats, hub/*, donations, hospitals): para listas
  grandes (missing/map hasta 2000 markers) cada cache-hit re-stringifica + hashea
  en el event loop. *Fix:* cachear el `{json, etag}` serializado junto al valor
  cacheado para que un cache-hit devuelva bytes pre-computados, en vez de
  re-stringify/re-hash por request. *Patrón de casa:* boahaus "trabajo sync
  (hashing/disco) cacheado una vez, nunca repetido por request"
  (`fileFallback.ts` FILE_CACHE).

---

## 3. Async en el request path — `app/api` vs vistas async ADRF de argo

### El estándar que el repo ya cumple casi siempre

La mayoría de los handlers de `app/api` siguen el patrón correcto: lectura
independiente con `Promise.all`, respuesta envuelta en `cached()` +
`jsonWithEtag()`, validación en servidor, errores estructurados. Esto es
equivalente, en espíritu, a las vistas async de argo bajo ADRF (Django REST
Framework async): el handler es `async`, no bloquea el event loop con I/O
síncrono, y fan-outea las lecturas independientes en paralelo. argo logra esto
con vistas `async def` + ORM async; mapa lo logra con `async function GET` +
drizzle sobre `neon-http`. Mismo objetivo: el request devuelve en ms, el loop
queda libre.

### Dónde mapa rompe el patrón (y cómo lo haría argo/boahaus)

**Bloqueo por I/O de terceros inline (M-2).** `app/api/sync/run/route.ts:104-113`
y `app/api/sync/cron/route.ts:64` hacen lo que una vista ADRF de argo **jamás**
haría: ejecutar un crawl paginado de feeds externos (`adapter.fetchAll`,
`sleep(200ms)` entre páginas) **dentro** del handler, manteniendo la conexión
abierta hasta 300s. En argo, una vista async que necesita trabajo de terceros
largo no lo `await`ea inline: dispara la tarea async (cola/worker) y devuelve. En
boahaus el equivalente exacto es `startProductScan`
(`skincare-product.controller.ts:45-90`): valida, encola
`enqueueAiJob(...)`, persiste el `job.id`, y devuelve `{ok:true, scanId, jobId}`
**sin awaitear** la IA — estilo 202. El cliente luego consulta vía SSE o status
poll (`getScanStatus`, controller:209-215). mapa debe hacer lo mismo: encolar un
job por fuente en la cola `hub-ingest` (que ya existe), devolver
`202 {ok, jobIds}`, y mover `runSync` a un processor. boahaus mismo marca el
anti-patrón opuesto (`runJobType.ts:84-98` bloqueando en
`waitUntilFinished(...180s)`) como algo a evitar — no lo repliques en mapa.

**Seq scans y N+1 en el request path (A-1, A-2, M-3).** Estos son el otro modo
de fallo async: el handler es async pero la latencia está dominada por trabajo
DB serializado o inindexable. `seedHospitalsIfNeeded` (174 INSERTs seriales),
`?q=` (seq scan por índice GIN inexistente), `hub/stats` (5 COUNT seriales). El
fix en los tres casos es el mismo principio que argo aplica con `select_related`
/ `Prefetch` y boahaus con `Promise.all`: I/O independiente corre concurrente, y
el trabajo pesado (seeding) sale del request path hacia una migración/worker.

**Hashing/serialización síncrona en el loop (B-8, B-9).** `jsonWithEtag` y el
proxy OpenPanel hacen CPU síncrona (sha1/md5/stringify) por request. argo bajo
ASGI tiene el mismo riesgo (CPU síncrona en una vista async bloquea el worker);
la disciplina es memoizar/cachear el resultado computado, no recomputarlo por
hit. mapa ya cachea los datos — solo le falta cachear los bytes serializados +
el etag junto a ellos.

---

## 4. Async en workers — `worker/` vs boahaus (BullMQ)

### Lo que mapa ya hace bien (a la altura de boahaus)

- **Procesos de worker dedicados con drain elegante.** `worker/index.ts` cablea
  SIGTERM/SIGINT y drena. Esto es el patrón boahaus de
  `aiWorker.ts:68-75`/`emailWorker.ts:8-17`: `await worker.close()` antes de
  `process.exit(0)`, aislamiento de crash/restart por proceso.
- **Colas aisladas por dominio con conexión Redis compartida.**
  `worker/queues.ts` define colas separadas (`tables`, `photos`, `hub-ingest`,
  `hub-images`) con rate-limit por cola — el mismo aislamiento per-dominio de
  boahaus (`aiQueue.ts`, `email.queue.ts`, `notifications.queue.ts`) donde un
  dominio lento no inanicia a otro.
- **Rate limiter de worker.** mapa SÍ tiene `limiter:{max,duration}`
  (`HUB_INGEST_RATE_MAX 100/60s`, photos/images), algo que boahaus marca como
  ausente en su propio código — aquí mapa supera la vara de boahaus.
- **Reintentos con backoff e idempotencia.** Jobs con `attempts:3` + backoff
  exponencial y `jobId` determinísticos, igual que la disciplina de
  `email.queue.ts:65-93` de boahaus (`-` no `:` en jobIds custom).

### Dónde mapa queda por debajo de la vara boahaus

- **Sin DLQ ni alerting (M-1).** boahaus lista explícitamente "No dead-letter
  queue... para trabajo crisis-sensible un DLQ + alerting es la vara" como
  antipatrón a evitar. mapa es crisis-sensible y no tiene DLQ — solo
  `console.error` + retención de 5000. Hay recuperación por rescan (no es pérdida
  irreversible), pero no hay forma fácil de ver QUÉ falló ni alerta de tasa.
- **Sin red de seguridad de proceso (B-1).** Igual gap que boahaus se auto-marca
  ("No process-level safety net... in any worker entrypoint"). mapa lo repite. En
  mapa el impacto es menor porque BullMQ atrapa los throws de processors y los
  jobs son idempotentes, pero el `worker/index.ts` de larga vida merece un
  `unhandledRejection` ruidoso.
- **Connection pool sobre-suscrito + conexión fijada a través de I/O de red
  (M-4).** boahaus mantiene el I/O fuera de transacciones largas; `migratePhoto`
  de mapa retiene un client pooleado a través de `fetch + R2 PUT` dentro de
  `BEGIN..COMMIT`. Patrón a copiar: claim/stamp en txn corta → I/O sin client →
  write en txn corta.
- **Señal de Retry-After ignorada (B-4), schedulers best-effort sin observabilidad
  (B-5).** boahaus empareja limiters con backoff y hace el event bus "ruidoso en
  cero subscriptores" para que un timbre perdido sea visible. mapa parsea
  Retry-After y lo descarta, y traga el fallo de registro de schedulers a un log
  sin readiness signal — menos observable que la vara boahaus.

### Lo que mapa NO necesita copiar de boahaus

boahaus usa un event bus Valkey pub/sub + SSE fan-out para señalizar
job→cliente cross-proceso (`eventBus.ts:34-80`). mapa **no** tiene un cliente
esperando el resultado de un job de migración en tiempo real — los workers son
productores batch/one-shot y schedulers. No agregues SSE/pub-sub aquí; sería
abstracción no pedida (YAGNI). El único lugar donde el patrón 202+poll/SSE de
boahaus aplica es M-2 (sync), y ahí basta con `202 {jobIds}` + un status poll
admin, no un event bus completo.

---

## 5. Plan de remediación priorizado

### Quick wins (horas, bajo riesgo, alto valor)

1. **A-6 — Corregir `TRUSTED_IP_HEADER`** en `secret.example.yaml:25`,
   `docker-compose.yml:39` y el manifiesto real, + ajustar `clientIp` para tomar
   el hop confiable más a la derecha. (config + ~5 líneas)
2. **A-4 / M-7-bis — Centralizar `hashIp()`** en `lib/ratelimit.ts` con
   `IP_SALT`, aplicar en contact/donations/confirm. Backfill si hay datos reales.
3. **A-3 — Envolver el GET de chat** en `cached()` + `jsonWithEtag()` (copiar de
   reports/missing). (~3 líneas)
4. **M-3 — `hub/stats` con `Promise.all`** (copiar de admin/data). (~5 líneas)
5. **B-3 — `Promise.all` en el enqueue de hubIngest** + contador. (~2 líneas)
6. **C-1 / A-5 — Quitar `notes`+`contact` de los DTOs públicos de pacientes** y/o
   cerrar tras `isAdminRequest`, + rate-limit en la búsqueda. (allowlist de DTO,
   patrón ya existente) — *este es quick-win en esfuerzo pero CRÍTICO en
   prioridad; hazlo primero.*

### Estructural (días, requiere diseño/migración)

1. **A-2 — Migración para `pg_trgm`/`unaccent`/`f_unaccent`/`idx_missing_search`**
   vía `infra/db/schema.ts` (`sql\`...\``) + `db:generate`. Hasta entonces, cada
   búsqueda es seq scan.
2. **M-5 — Añadir el índice único parcial `(source, external_id)`** al esquema +
   migración, igualando el predicado del `ON CONFLICT`. Verificar si prod ya lo
   tiene out-of-band antes de asumir.
3. **A-1 — Mover el seeding de hospitales** del request path a una migración o
   job de worker; mientras tanto, INSERT multi-fila único.
4. **A-7 — Patrón "el público propone, el admin dispone" para `found`**: cola de
   moderación `status='pending_found'` + validación de foto + log de auditoría.
5. **M-2 — Migrar el sync a la cola BullMQ existente**: enqueue por fuente,
   devolver `202 {jobIds}`, processor en el worker, status poll admin. (Patrón
   202 de boahaus.)
6. **M-1 — DLQ + alerting** para todas las colas; reflejar la ruidosidad de
   `getFailed()` más allá de `tables`.
7. **M-7 — Rate limiter respaldado por Valkey** (`INCR`+`EXPIRE`), `Map` solo como
   fallback de dev.
8. **M-4 — Sacar el R2 PUT/fetch de la transacción DB** en `migratePhoto` y/o
   redimensionar el pool.
9. **M-6 — Consolidar los cinco parsers de data-URI** en `lib/image.ts` con un
   único `ALLOWED_MIME`; rechazar svg inline.

### Decisión de producto (no técnica)

- **M-8 — `contact` en desaparecidos**: decidir si el canal de contacto debe ser
  público o gateado (click-to-reveal + captcha). Como mínimo, sacarlo del
  endpoint de lista cacheado para frenar harvesting masivo.

### Hardening de fondo (cuando haya holgura)

B-1, B-2, B-4, B-5, B-6, B-7, B-8, B-9 — defense-in-depth y limpieza de bajo
impacto. Ninguno bloquea producción; agruparlos en un PR de "worker hardening" y
otro de "request-path micro-opt".

---

## 6. Auditoría runtime (black-box) de la API en producción

Medición externa contra `terremotovenezuela.app` (latencia observada por
endpoint). Complementa la auditoría estática: confirma de forma independiente
varios hallazgos (A-1 hospitales, A-2 búsqueda, M-3 hub) y aporta tres nuevos
(R-1 count, R-2 default limit, R-3..R-6 contratos/doc). Cada fila runtime se
**reconcilia** abajo con lo que el código realmente muestra — algunas hipótesis
de la medición se corrigen con la evidencia del repo.

### Resumen de latencia

| Endpoint | Tiempo | Estado |
|---|---|---|
| `GET /api/readyz` | 203 ms | 🟢 |
| `GET /api/geo` | 203 ms | 🟢 |
| `GET /api/missing/stats` | 176 ms | 🟢 |
| `GET /api/hospitals?state=Miranda` | 179 ms | 🟢 |
| `GET /api/hospitals?zone=P0` | 181 ms | 🟢 |
| `GET /api/hospitals?q=...` | 199 ms | 🟢 |
| `GET /api/donations` | 175 ms | 🟢 |
| `GET /api/chat` | 178 ms | 🟢 |
| `GET /api/reports` | 449 ms | 🟡 |
| `GET /api/hospitals` (sin params, 182 filas) | 1994 ms | 🔴 |
| `GET /api/missing` (página default) | 190 ms | 🟢 |
| `GET /api/missing?status=active&pageSize=20` | 2485 ms | 🔴 |
| `GET /api/missing?status=active&page=25` | 224 ms | 🔴* |
| `GET /api/missing?status=found&page=1` | 5740 ms | 🔴 |
| `GET /api/missing?q=maria` | 2911 ms | 🔴 |
| `GET /api/missing/map` (sin bbox) | 417 ms | 🟡 |
| `GET /api/missing/map` (con bbox) | 887 ms | 🔴 |
| `GET /api/hub/reports?type=missing_person` | 1768 ms | 🔴 |

> \* La medición notó que páginas profundas a veces responden más rápido que la
> página 1 — eso es consistente con el cache de 2s por clave
> (`missing:<status>:<page>:<pageSize>:<q>`, `app/api/missing/route.ts:36-38`):
> una página recién cacheada gana a un miss frío. No es la paginación offset en
> sí (ver R-1).

### Hallazgos runtime (reconciliados con el código)

#### R-1. `status=active`/`found` lento — NO es falta de índice de status; es el COUNT exacto sobre la tabla filtrada

- **Medición:** `status=active` 2.5s, `status=found` 5.7s vs default 190ms.
- **Hipótesis original:** "falta índice en `status`". **Incorrecta** — el código
  SÍ tiene `index("idx_missing_status_created").on(t.status, t.createdAt.desc())`
  (`infra/db/schema.ts:106`). El filtro de status está indexado.
- **Causa real (confirmada en código):** `listMissingPage`
  (`lib/missing.ts:334-338`) corre un `SELECT count(*) FROM missing_persons
  <where>` **sin acotar** en cada request sin búsqueda (el cap de
  `SEARCH_COUNT_CAP=500` solo aplica cuando `hasSearch`). Con 67,487 `active` y
  10,988 `found`, ese COUNT exacto escanea decenas de miles de filas por request
  (el índice parcial cubre el WHERE pero el COUNT sigue siendo agregación sobre
  todo el match). La página default (sin filtro / primer hit) cae en el cache de
  2s, por eso 190ms; un filtro recién pedido paga el COUNT completo.
- **Fix:** Acotar también el COUNT sin búsqueda (`... LIMIT 1000) t` → mostrar
  "1000+") como ya se hace para búsqueda; o usar un conteo aproximado
  (`reltuples` / `pg_class`) para el total no filtrado; o cachear los totales por
  status con TTL más largo y separado de las páginas. La paginación offset en sí
  no es el cuello a esta escala — el COUNT exacto sí.

#### R-2. `GET /api/hospitals` sin params devuelve las 182 filas con `limit` default 500 (~2s) — y dispara el seed N+1 (= A-1)

- **Medición:** sin params ~2s; con `limit=10` 335ms.
- **Confirmado en código:** `app/api/hospitals/route.ts:117` lee
  `limit = Number(params.get("limit") ?? "500")`, y `lib/hospitals.ts:157` lo
  clampa a `[1,1000]` con default 500. El Swagger documenta `default: 500`
  (`route.ts:46`) — footgun real para cualquier frontend que llame sin params.
- **Pero los ~2s no son por las 182 filas** (son pocas): el primer hit dispara
  `seedHospitalsIfNeeded` con 174 INSERTs seriales en el request path — es
  exactamente **A-1**. La latencia alta es el seeding, no el tamaño del payload.
- **Fix:** (a) bajar el default a 50 o exigir `limit` explícito (R-2), y (b) sacar
  el seed del request path (A-1). Ambos.

#### R-3. `?q=maria` ~2.9s — seq scan por el índice GIN inexistente (= A-2)

- **Medición:** 2.9s, empeorará con el dataset.
- **Es exactamente A-2:** `accentSearchReady()` devuelve `false` en prod porque
  `idx_missing_search`/`pg_trgm`/`unaccent` no existen, así que cada búsqueda cae
  al ILIKE con wildcard inicial sobre una expresión concatenada — inindexable.
- **Fix:** la migración de A-2 (crear el índice GIN trigram). Es el mismo hallazgo
  visto desde afuera.

#### R-4. `GET /api/hub/reports?type=missing_person` ~1.7s; los otros 4 tipos <300ms (relacionado con M-3)

- **Confirmado:** `hub_missing_persons` tiene ~49k filas vs cientos en los otros
  tipos, así que el COUNT + lectura de esa tabla domina. El patrón es el mismo
  que M-3 (`hub/stats` con counts seriales): falta paginar/acotar el tipo pesado.
- **Fix:** paginar `hub/reports` por cursor (no devolver todo el tipo), y/o cachear
  el conteo del tipo pesado por separado. Mismo principio que M-3.

#### R-5. [DOC] Swagger de `hub/reports` documenta enums equivocados (`missing`, `report`) — ambos dan 400

- **Confirmado:** los valores aceptados reales son `missing_person`, `checkin`,
  `help_request`, `help_offer`, `damaged_building` (`worker/hub/config.ts:41-47`).
  La doc OpenAPI lista valores que el endpoint rechaza con 400 — la spec miente.
- **Fix:** corregir el `enum` del parámetro `type` en el bloque `@swagger` de
  `app/api/hub/reports/route.ts` a los cinco valores reales. (Per `CLAUDE.md`,
  todo endpoint debe documentar su contrato real.)

#### R-6. [DOC/CONTRATO] Inconsistencias de schema y paginación

- **R-6a — Formas de paginación divergentes.** `/api/missing` devuelve
  `{ people, total, totalCapped, page, pageSize, totalPages, persistent }`;
  `/api/patients/search` devuelve `{ results, hasMore }`. Dos contratos distintos.
  *Fix:* estandarizar uno (`{ items, total, page, pageSize, totalPages }` o
  `{ items, hasMore, nextCursor }`) en toda la superficie.
- **R-6b — `nationality` ausente del schema OpenAPI.** El objeto `MissingPerson`
  incluye `nationality` en cada respuesta pero no está declarado en el schema
  `MissingPerson` de `lib/swagger.ts`. *Fix:* añadirlo. (Recordatorio: este campo
  vino del merge de `main` durante la migración Drizzle — la doc quedó atrás.)
- **R-6c — `states: null` siempre.** La respuesta de hospitales siempre trae
  `"states": null`. *Fix:* poblarlo (cuando `wantsStates`) o quitarlo del schema.
- **R-6d — Sin paginación en `/api/reports` (145 filas, array plano) ni
  `/api/chat` (39 msgs).** Hoy OK por volumen; añadir paginación por cursor antes
  de que crezcan. (Para chat, el fix de A-3 —`cached`+`etag`— es ortogonal y
  también aplica.)

#### R-7. `/api/missing/map` sin bbox vuelca hasta 500 markers (= M-? / diseño)

- **Confirmado:** el default de markers está hardcodeado (`lib/missing.ts:502`
  `.limit(500)`); sin bbox devuelve markers globales. Para 67k+ desaparecidos
  conviene exigir bbox o un default mucho menor + clustering server-side.
- **Fix:** exigir bbox o bajar el default; considerar clustering. Decisión de
  producto + un cambio acotado.

### Lo que la medición confirma que está bien

Coincide con la auditoría estática: las queries filtradas de hospitales
(`?state=`, `?zone=`, `?q=`) son rápidas y correctas; `patients/search` tiene un
contrato limpio `hasMore`+`limit` (aunque ojo: ese endpoint es C-1, rápido pero
filtra PII); `missing/stats` vuela (cacheado); el rate-limiting está documentado
en los endpoints de escritura; el auth admin es consistente.

> Nota de prioridad: el endpoint runtime "más rápido y limpio" según la medición
> (`patients/search`) es a la vez el **CRÍTICO C-1** por fuga de PII. Rápido ≠
> seguro. Atender C-1 primero pese a su buen perfil de latencia.

### Tabla de remediación runtime (mapeada a hallazgos existentes)

| Prioridad | Fix | Mapea a |
|---|---|---|
| 🔴 ALTA | Acotar/aproximar el COUNT de `/api/missing` (no es falta de índice de status) | **R-1** (nuevo) |
| 🔴 ALTA | Migración índice GIN trigram para `?q=` | **A-2 / R-3** |
| 🔴 ALTA | Corregir enums de Swagger en `hub/reports` | **R-5** (nuevo) |
| 🟡 MED | Default `limit` de hospitales 500→50 o exigir explícito | **R-2** (nuevo) |
| 🟡 MED | Sacar seed de hospitales del request path | **A-1 / R-2** |
| 🟡 MED | Paginar `hub/reports` (tipo pesado) por cursor | **R-4 / M-3** |
| 🟡 MED | Paginación por cursor en `/api/chat` y `/api/reports` | **R-6d** (nuevo) |
| 🟡 MED | Estandarizar forma de paginación | **R-6a** (nuevo) |
| 🟡 MED | Añadir `nationality` al schema OpenAPI | **R-6b** (nuevo) |
| 🟢 BAJA | Poblar o quitar `states: null` | **R-6c** (nuevo) |
| 🟢 BAJA | Exigir bbox / bajar default en `/api/missing/map` | **R-7** (nuevo) |

---

### Cierre

El repo está mejor de lo que la frase "todo esto es basura" sugiere: el patrón
correcto ya vive en el código (cached+etag, allowlist de columnas, colas
aisladas, drain elegante). El trabajo no es reescribir; es (1) tapar las fugas de
PII médica sin auth, (2) arreglar la config que anula el rate-limiting, y (3)
terminar de aplicar a las pocas rutas rezagadas los mismos patrones que el resto
del repo ya cumple — incluyendo mover el sync a la cola BullMQ que ya tienes,
exactamente como boahaus mueve la IA fuera del request path.
