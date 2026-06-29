# RFC 0006 — Hub de datos públicos: réplica saneada con SQL crudo (TCP) y API

Estado: propuesto
Fecha: 2026-06-29
Relacionado: `infra/tofu/{postgres,firewall,network,variables}.tf`,
`infra/tofu/cloud-init/postgres.yaml.tftpl`, `infra/db/schema.ts`,
`backend/src/auth/capabilities.ts`, RFC 0002 (federación hub),
PR #171 (API keys self-service).

## 0. Objetivo

Convertir el proyecto en un **hub de datos** para Venezuela: terceros que quieran
consumir nuestra información podrán hacerlo de dos formas, sin que nunca toquen la
base operativa ni los datos sensibles:

- **Vía A — API key** (ya existe, PR #171): integraciones máquina-a-máquina contra
  `api/public/*` con scopes least-privilege.
- **Vía B — SQL crudo (esta RFC):** una **réplica en tiempo real, saneada** de la
  base, expuesta por TCP (5432) con TLS, a la que un consumidor se conecta con
  `psql` / su propio cliente y corre sus propias consultas y joins.

La pieza central de la Vía B es que el hub **no es una copia de toda la base**: es
una **segunda base que solo contiene lo publicable**. La información sensible (PII
de desaparecidos, pacientes, usuarios, hashes de API keys, auditoría, IPs) **nunca
se replica**, así que no hay nada que filtrar — no está ahí.

Esta RFC **no toca infra todavía**. Define el diseño para que el equipo revise,
sobre todo la **lista de columnas publicables** (§4), que es la frontera de
privacidad completa.

## 1. Por qué réplica lógica y no física

Hay dos tipos de replicación en Postgres. Solo una permite sanear:

| | Física (streaming) | **Lógica (pub/sub)** ← elegida |
|---|---|---|
| Qué copia | Todo el cluster, byte a byte | **Por tabla, por columna, por fila** |
| ¿Excluir tablas PII? | ❌ no, todo o nada | ✅ sí — lo no publicado no existe |
| ¿Tiempo real? | Sí (ms) | **Sí — streamea el WAL en near real-time** |
| Subscriber | Espejo read-only idéntico | **Base independiente** (sus roles/índices) |

Con replicación física el hub sería idéntico al primario: tendría
`missing_persons`, `hospital_patients`, `users`, `api_keys`, `audit_log`. La única
defensa serían los `GRANT/REVOKE`, y los catálogos de Postgres (`pg_class`,
`information_schema`) son **legibles por cualquier rol** — la doc oficial dice que
revocar `USAGE` "no es una forma completamente segura de impedir acceso". Es decir:
hasta el esquema y los nombres de columnas sensibles se filtran como metadata.

Con replicación **lógica** publicamos solo un subconjunto de tablas y columnas. La
PII **no se copia**, así que el modo de fallo de "olvidé un REVOKE" se convierte en
"esa columna nunca se replicó". La frontera de privacidad es **estructural**, no de
configuración.

## 2. Arquitectura resultante

```
  Primario (mapa-postgres)          Hub (mapa-hub-postgres) — NUEVO VPS pet
  ┌─────────────────────────┐       ┌──────────────────────────────┐
  │ base operativa COMPLETA  │       │ SOLO tablas/columnas públicas │
  │ + PII, users, api_keys,  │ ───▶  │ (sin PII, sin secretos)       │
  │   audit_log, IPs…        │ repl  │ default_transaction_read_only │
  │ wal_level = logical      │ lógica│ ssl = on                      │
  │ PUBLICATION hub_pub      │ por   │ SUBSCRIPTION hub_sub          │
  └─────────────────────────┘ red   └──────────────────────────────┘
        IP privada 10.0.0.0/16        privada              ▲ público 5432
        (nunca expone 5432 público)                        │ TLS verify-full
                                                           │ pg_hba allowlist
                                              Consumidor externo (psql / cliente)
                                              host=data.terremotovenezuela.app
                                              sslmode=verify-full
```

- **Primario → hub:** la conexión de replicación va por la **red privada**
  (`10.0.0.0/16`), nunca por internet. Idéntico patrón que app → DB hoy.
- **Hub → mundo:** único punto con 5432 público, en un **firewall aparte** y con
  **allowlist de IPs** de consumidores (no `0.0.0.0/0`).
- **No hay k8s aquí.** Postgres vive en VPS (no en el clúster), así que esto es
  tofu (`hub.tf` espejando `postgres.tf`) + cloud-init, no un Service LoadBalancer.

## 3. Riesgo sobre el primario (y cómo se acota)

La pregunta clave del equipo: **¿si el hub muere, pasa algo al primario?** No.
La replicación lógica está desacoplada: el primario publica; si nadie escucha,
sigue sirviendo la app. El hub es downstream y desechable (se reconstruye con una
suscripción nueva).

El **único** riesgo real va en sentido contrario y tiene nombre: **retención de
WAL por slot de replicación**. Al suscribirse, el primario crea un *replication
slot* y **no borra WAL que el hub no haya consumido**. Si el hub cae y **nadie se
entera por días**, el WAL se acumula en el disco del primario (`cx23`, volumen
fijo) y un Postgres sin disco **sí** se detiene. Es el único camino por el que el
hub afecta al primario.

Mitigación **obligatoria** (convierte el riesgo en no-evento):

```
# postgresql.conf del PRIMARIO
max_slot_wal_keep_size = 2GB   # tope: si el hub se atrasa más de esto,
                               # se invalida el slot. Cuesta re-sync del hub,
                               # NUNCA llenar el disco del primario.
```

Más una alerta de uso de disco en el primario.

| Escenario | Efecto en el **primario** |
|---|---|
| Hub se borra / crashea | **Ninguno** — la app sigue. Se reconstruye el hub. |
| Hub caído horas | Ninguno (WAL dentro del tope) |
| Hub caído días, sin tope | ⚠️ WAL llena disco → **único** riesgo real |
| Igual, **con `max_slot_wal_keep_size`** | Slot se invalida, hub re-sincroniza, **primario OK** |
| Consumidor corre query pesada en hub | Ninguno — es otro servidor |
| Bug/brecha en el hub | Ninguno — el hub no tiene PII ni ruta de vuelta |

## 4. Frontera de privacidad: qué se publica (REVISAR)

El propósito del hub es **humanitario**: que cualquiera pueda buscar personas
desaparecidas, no identificadas, pacientes en hospitales y contactos. Que esos
datos salgan **es la misión**, no una fuga. La regla es por **tabla completa**: si
una tabla es de datos públicos/humanitarios, se replica **entera**. La frontera de
privacidad son **las tres categorías que NO se envían** (§4.2).

Excepción: una columna que sea **rastreo interno nuestro** (no el dato
humanitario) puede excluirse por lista de columnas — ver `ip_hash` en §4.1.

### 4.1 Publicables (tablas completas, todas sus columnas salvo lo indicado)

Datos públicos / humanitarios:

- **`earthquakes`** — sismos USGS.
- **`reports`** — reportes ciudadanos de emergencia.
- **`hospitals`** — directorio de hospitales.
- **`hospital_supply_statuses`** — estado de insumos por hospital.
- **`hospital_supply_needs`** — necesidades de insumos por hospital.
- **`donations`** — donaciones. ❌ Excluir `ip_hash`, `user_agent` (rastreo del
  donante, no dato público).
- **`missing_persons`** — personas desaparecidas. **Núcleo de la misión.**
- **`unidentified_persons`** — personas no identificadas (ayuda a emparejar con
  familias).
- **`hospital_patients`** — pacientes en hospitales (para que las familias los
  ubiquen).
- **`contact_messages`** — mensajes de contacto. ⚠️ **Decisión pendiente:**
  ¿excluir `ip_hash`? (rastreo interno, no el mensaje). Recomendación: excluirlo.
- **`report_confirmations`** — confirmaciones de reportes. ⚠️ Contiene `ip_hash`
  como parte de la PK; si se publica, el `ip_hash` viaja. Misma decisión que
  arriba (recomendación: excluir el rastreo de IP — ver §4.3).

> Columnas que son **plomería interna** (no dato humanitario) presentes en estas
> tablas: `photo_migrated_at`, `external_id`, `source`, `source_url`,
> `photo_external_url` (bookkeeping de ingesta/R2). Inofensivas pero ruido para el
> consumidor. Por simplicidad se envían igual, salvo que el equipo prefiera un
> contrato más limpio.

### 4.2 Nunca se publican (no entran en la PUBLICATION → no existen en el hub)

Tres categorías, y solo estas:

- **Operativo / interno:** `chat_messages` (interno),
  `hospital_supply_help_requests`, `hospital_poc_assignments`,
  `hospital_supply_events`, `damage_candidates`, `geocode_cache`, `sync_state`,
  `sync_runs`, `click_counters`, `click_counter_dedup`, `analytics_events`.
- **Seguridad / secretos:** `users`, `roles`, `role_capabilities`,
  `capabilities`, `permission_grants`, `invitations`, `password_resets`,
  `api_keys`, `audit_log`.
- **Federación:** `hub_missing_persons`, `hub_checkins`, `hub_help_requests`,
  `hub_help_offers`, `hub_damaged_buildings`, `hub_sync_state`.

### 4.3 Nota sobre `ip_hash`

`report_confirmations` lo lleva en su clave primaria `(report_id, ip_hash)` y
`contact_messages` como columna. El `AGENTS.md` prohíbe exponer IPs (crudas o
comparables). Un hash de IP sigue siendo metadata re-identificable. Opciones:
(a) excluir `ip_hash` por lista de columnas — para `report_confirmations` implica
publicar solo `report_id, created_at` (se pierde la PK en el hub, aceptable para
un destino read-only) o agregar a un conteo; (b) no publicar esas dos tablas.
**Recomendación: (a)** — el dato humanitario sale, el rastreo de IP no.

## 5. Cómo se hace (mecánica concreta)

### 5.1 Primario — habilitar replicación lógica (UNA sola vez)

```sql
-- postgresql.conf (requiere UN restart — ver §6)
wal_level = logical
max_slot_wal_keep_size = 2GB
```

```
# pg_hba.conf del primario — conexión de replicación desde la IP privada del hub
hostssl  replication  hub_repl  10.0.0.0/16  scram-sha-256
hostssl  mapa_app     hub_repl  10.0.0.0/16  scram-sha-256
```

```sql
-- rol de replicación en el primario (mínimo: REPLICATION + SELECT de lo publicado)
CREATE ROLE hub_repl WITH LOGIN REPLICATION PASSWORD '...';
GRANT SELECT ON
  earthquakes, reports, hospitals,
  hospital_supply_statuses, hospital_supply_needs, donations,
  missing_persons, unidentified_persons, hospital_patients,
  contact_messages, report_confirmations
TO hub_repl;

-- Publicación. Tablas humanitarias enteras; lista de columnas SOLO donde se
-- excluye rastreo interno (ip_hash / user_agent). Postgres 15+.
CREATE PUBLICATION hub_pub FOR TABLE
  earthquakes,
  reports,
  hospitals,
  hospital_supply_statuses,
  hospital_supply_needs,
  donations            (id, name, amount_usd, created_at, status),  -- sin ip_hash/user_agent
  missing_persons,
  unidentified_persons,
  hospital_patients,
  contact_messages     (id, name, email, subject, message, read, created_at),  -- sin ip_hash
  report_confirmations (report_id, created_at);                                 -- sin ip_hash
```

> Pendiente del equipo (§4.3): si se decide **no** excluir `ip_hash`, quitar las
> listas de columnas de `contact_messages`/`report_confirmations`; si se decide no
> publicarlas, sacarlas de aquí y del `GRANT`. La recomendación de la RFC es
> excluir `ip_hash` y publicar el resto.

### 5.2 Hub — VPS nuevo (tofu)

`infra/tofu/hub.tf` espeja `postgres.tf`: `hcloud_server` con `prevent_destroy` +
`ignore_changes`, volumen `prevent_destroy`, IP privada propia, y un **firewall
separado** `mapa-hub-fw`:

```hcl
resource "hcloud_firewall" "hub" {
  name = "mapa-hub-fw"
  rule { direction = "in" protocol = "tcp" port = "22"
         source_ips = var.admin_ips }            # SSH solo admin
  rule { direction = "in" protocol = "tcp" port = "5432"
         source_ips = var.hub_allowed_ips }      # ALLOWLIST de consumidores
}
```

> Nota Hetzner (ya documentada en `firewall.tf`): el firewall solo filtra tráfico
> **público**; el privado (`10.0.0.0/16`) lo bypassea. Por eso la replicación
> primario→hub no necesita regla, y la regla de 5432 aquí solo gobierna internet.

cloud-init del hub: instala Postgres, crea la base pública, las tablas publicadas
(solo esas columnas), `ssl = on`, `default_transaction_read_only = on`,
`listen_addresses = '*'`, y el `pg_hba.conf` con `hostssl` (TLS obligatorio).

### 5.3 Hub — suscripción

```sql
CREATE SUBSCRIPTION hub_sub
  CONNECTION 'host=10.0.0.X dbname=mapa_app user=hub_repl sslmode=require'
  PUBLICATION hub_pub;
-- copia inicial de las tablas publicadas y luego streamea cambios en vivo,
-- en el mismo orden de commit que el primario.
```

### 5.4 Rol por consumidor (en el hub, no en el primario)

```sql
CREATE ROLE consumer_acme LOGIN PASSWORD '...' CONNECTION LIMIT 5;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM consumer_acme;
-- el hub SOLO contiene tablas publicadas, así que GRANT a todas es seguro:
GRANT SELECT ON ALL TABLES IN SCHEMA public TO consumer_acme;
ALTER ROLE consumer_acme SET statement_timeout = '30s';
ALTER ROLE consumer_acme SET default_transaction_read_only = on;
```

El consumidor se conecta así (TLS con verificación de host obligatoria):

```bash
psql "host=data.terremotovenezuela.app port=5432 dbname=public_db \
      user=consumer_acme sslmode=verify-full"
```

### 5.5 Backfill inicial y evolución del esquema (VALIDADO en local)

Todo lo de esta sección se probó end-to-end en docker compose (publisher real con
133k+ filas + un hub-db desechable). Resultados y aprendizajes:

**Backfill inicial — automático.** `CREATE SUBSCRIPTION` hace un snapshot de las
filas pre-existentes y luego streamea cambios. No hay job de backfill: la
suscripción *es* el backfill. Validado: las 11 tablas copiaron con conteo exacto
(`missing_persons` 133.060 = 133.060, etc.) y un INSERT en vivo apareció en el hub
en segundos. La exclusión de `ip_hash`/`user_agent` se confirmó: una donación con
`ip_hash='SECRET…'` en el primario llegó al hub **sin** esa columna (no existe).

**Agregar una tabla nueva mañana — runbook de 4 pasos (no 3).** La replicación
lógica **no propaga DDL**: el `CREATE TABLE` del primario NO crea la tabla en el
hub, y una tabla nueva **no se publica por sí sola** (default seguro: no se filtra
nada sin acción explícita). El runbook validado:

```sql
-- 1. HUB: crear la tabla primero (en prod: la MISMA migración Drizzle).
--    Debe tener TODAS las columnas publicadas (ver footgun abajo).
CREATE TABLE shelters (id text PRIMARY KEY, name text, capacity integer, created_at bigint);

-- 2. PRIMARIO: GRANT SELECT al rol de replicación.  ← PASO QUE SE OLVIDA
GRANT SELECT ON shelters TO hub_repl;

-- 3. PRIMARIO: agregar a la publicación.
ALTER PUBLICATION hub_pub ADD TABLE shelters;

-- 4. HUB: refrescar → backfillea las filas pre-existentes (copy_data=true).
ALTER SUBSCRIPTION hub_sub REFRESH PUBLICATION;
```

Todo online, sin restart, app viva. Validado: 3 filas pre-existentes
backfillearon + 1 INSERT posterior llegó en vivo (4 en el hub).

**Dos footguns que el test reveló (silenciosos — quedan en estado `d` reintentando):**

- **Falta `GRANT SELECT`** → el worker de sync falla con `permission denied for
  table X` y reintenta cada ~3 s para siempre, tabla en estado `d`, 0 filas. Por
  eso el paso 2 es obligatorio. Diagnóstico: `docker logs`/`pg_stat_subscription`
  + `SELECT srrelid::regclass, srsubstate FROM pg_subscription_rel`.
- **Columnas faltantes en el hub** → `logical replication target relation … is
  missing replicated columns`. La tabla del hub debe tener **todas** las columnas
  publicadas. Por eso el hub corre las **mismas migraciones Drizzle** (no stubs a
  mano). Las columnas extra en el hub están permitidas; las faltantes rompen.

**Recuperación de una tabla atascada** (validado): no se puede `DROP`/alterar una
tabla mientras su sync está en `d`. Hay que sacarla del flujo primero:

```sql
-- PRIMARIO:                            -- HUB:
ALTER PUBLICATION hub_pub DROP TABLE x; ALTER SUBSCRIPTION hub_sub REFRESH PUBLICATION;
-- (ahora x está libre en el hub) arreglar columnas: DROP TABLE x; CREATE TABLE x (…correcto…);
-- PRIMARIO: GRANT SELECT ON x TO hub_repl; ALTER PUBLICATION hub_pub ADD TABLE x;
-- HUB: ALTER SUBSCRIPTION hub_sub REFRESH PUBLICATION;  → vuelve a 'r'
```

**Flujo operativo permanente (cuando nace una tabla en `infra/db/schema.ts`):**

```
Tabla nueva + migración Drizzle
   ├─ primario: Job migrate la aplica (ya pasa hoy)
   └─ ¿es publicable? (revisión §4)
        ├─ NO  → fin. Nunca entra en hub_pub. (default seguro)
        └─ SÍ  → hub corre la misma migración → GRANT → ALTER PUBLICATION ADD
                 TABLE → REFRESH (los 4 pasos de arriba)
```

### 5.6 Gate de CI: ninguna migración pasa sin decisión por réplica

**Problema:** el flujo de arriba depende de que un humano se acuerde. El riesgo
real es **olvido**: alguien agrega una migración, llega al primario, y nadie
decidió qué hacen las réplicas → o el hub queda a la deriva (tabla publicable que
nunca aparece) o un sync se rompe en silencio. Hay que volverlo **imposible de
olvidar**, no "recordable".

**Patrón (estándar de industria, híbrido).** La forma débil es un checklist que el
autor *marca* (depende de diligencia — justo lo que no queremos). La forma robusta
**parsea el DDL de la migración** y exige una decisión explícita por réplica solo
cuando hace falta (estilo Squawk/Atlas). Reusamos la maquinaria que el repo YA
tiene: reglas propias en CI con tests (`backend/eslint-rules/`).

**Manifiesto** keyed por tag de migración (`_journal.json` es la lista canónica):

```jsonc
// infra/db/replicas.manifest.json
{
  "replicas": ["hub"],            // mirrors registrados (genérico para N futuros)
  "publishable": [                // espejo de §4.1 — la frontera, en código
    "earthquakes","reports","hospitals","hospital_supply_statuses",
    "hospital_supply_needs","donations","missing_persons",
    "unidentified_persons","hospital_patients","contact_messages",
    "report_confirmations"
  ],
  "migrations": {
    "0010_opposite_tombstone": { "hub": "none" },          // irrelevante al hub
    "0011_add_shelters":       { "hub": "publish" },        // hub publica (runbook §5.5)
    "0012_internal_thing":     { "hub": "none" }
  }
}
```

**Checker** `scripts/check-replica-policy.mjs` (corre en `npm run lint` **y** en el
workflow de deploy — doble red, como las reglas de endpoints):

```
Por cada tag en infra/db/migrations/meta/_journal.json:
  1. Falta key en manifest.migrations[tag]            → FALLA
  2. Falta verdicto para ALGUNA réplica registrada    → FALLA
     (agregar un mirror nuevo a `replicas` retro-exige verdicto en todas
      las migraciones → obliga a decidir el backfill histórico)
  3. Parsear el .sql: CREATE TABLE / ALTER TABLE … ADD COLUMN / DROP …
       • DDL toca tabla PUBLICABLE + verdicto "none"   → FALLA
         ("0011 toca `reports` (publicable) y declara none")
       • DDL toca publicable + verdicto "publish"/acción → OK
       • DDL solo toca no-publicables + "none"          → OK
       • sin DDL (migración solo de datos) + "none"      → OK
```

La propiedad bulletproof: no es "¿marcaste la casilla?" sino **"el SQL dice que
tocaste una tabla publicada, así que NO puedes declarar 'nada que hacer'."**
Falsos positivos legítimos (una migración que de verdad necesita `none` sobre algo
que parece publicable) llevan `"override": "<razón>"` — explícito, revisado,
grepeable; nunca silencioso. Mismo espíritu que `// eslint-disable … -- razón`.

**Cuándo construirlo.** El gate solo tiene sentido cuando exista al menos una
réplica (§9 fase 2): un linter que protege un contrato sin contraparte es ruido.
Por eso se **especifica aquí** y se **implementa junto con el hub** (ver §10).

`wal_level` es parámetro `postmaster`: cambiarlo de `replica` a `logical`
**requiere un restart** en Postgres ≤ 18 (estamos en PG 15 vía Debian 12). No hay
truco zero-downtime para ese primer cambio. **Pero**:

- Es **un restart de segundos, una sola vez en la vida**. La app ya tolera rolls
  de pods; se pliega al **próximo deploy/reboot rutinario**, no necesita ventana
  de mantenimiento especial. Medido en local: Postgres volvió a aceptar
  conexiones en **~0,6 s** y el backend `/api/readyz` **nunca devolvió un error**
  (el pool reconecta solo). En prod será algo mayor pero del mismo orden.
- Una vez `logical` está activo, **agregar más mirrors es zero-downtime, zero
  restart** — solo SQL (`CREATE SUBSCRIPTION` en el nuevo hub; reusar o `ALTER
  PUBLICATION` si cambia el set). La doc lo confirma: agregar subscribers "no
  requiere reiniciar".

| Acción | ¿Downtime? | Cuándo |
|---|---|---|
| Habilitar `wal_level=logical` (PG 15) | ⚠️ un restart ~seg, una vez | Setup inicial |
| Crear el primer hub + suscripción | ✅ ninguno | Setup inicial |
| **Agregar 2º, 3er, N-ésimo mirror** | ✅ **ninguno, nunca** | Cuando sea |
| Un mirror muere | ✅ ninguno al primario | (el tope de WAL protege disco) |

(Si algún día el primario sube a PG 19+, hasta ese único restart desaparece —
pero no vale upgrade mayor solo por esto.)

## 7. Gobernanza del acceso (IMPLEMENTADO)

El diseño final mejora el boceto original: el acceso lo **gestiona el backend**,
no se editan tofu/pg_hba por consumidor. Una acción del super admin hace TODO:
detecta/abre la IP en el firewall (API Hetzner) + crea el rol Postgres + entrega
la credencial una vez. Onboarding sin tocar infra.

### 7.1 Capacidad + tier super admin

```ts
// backend/src/auth/capabilities.ts
{ key: "mirror:manage", category: "auth",
  description: "Emitir/revocar acceso a la réplica pública (SQL hub)" }
```

`mirror:manage` es la capacidad MÁS sensible (abre un puerto público + crea
credenciales de DB), así que:

- **No se concede por rol.** Tiene un **corte en `auth/resolve.ts` ANTES del
  short-circuit del admin semilla**: `if (cap === "mirror:manage") return
  user.isSuperAdmin`. Ni el admin normal (con comodín `*`) la tiene — solo un
  **super admin** (`users.is_super_admin`, tier por encima del admin semilla).
- El seed marca al admin semilla como super admin y **excluye** `mirror:manage`
  del bundle del rol admin (auto-sanación: borra cualquier grant viejo). Así no
  queda un grant inerte que se activaría si el corte se quitara.
- La UI (`can()`) trata `mirror:manage` fuera del comodín `*`: la pestaña
  "Réplica pública" solo aparece a super admins. Espeja el corte del backend.

### 7.2 Flujo (anti-escalada + auditoría)

`POST /api/public/hub-credentials` (gateado, rate-limit, `writeAudit`):
1. abre la IP del consumidor en `mapa-hub-fw` (`lib/hetzner-firewall.ts`);
2. crea `consumer_<uuid>` con password en el hub vía el rol `hub_admin`
   (CREATEROLE, no superuser) + `GRANT SELECT` solo a las tablas publicadas +
   `statement_timeout` + read-only;
3. devuelve la conexión **una sola vez** (la password nunca se guarda; el libro
   mayor `hub_credentials` guarda rol + IP para revocar).

Revocar = `REVOKE` grants + `DROP ROLE` + cerrar IP + soft-delete (idempotente).
No se puede gestionar con una sesión por API key (exige login humano).

### 7.3 IPs: allowlist, no puerto abierto al mundo

El firewall `mapa-hub-fw` arranca con `hub_consumer_ips=[]` → **5432 cerrado a
internet**. El backend agrega/quita IPs por la API de Hetzner al emitir/revocar.
Defensa en profundidad: firewall (IP) + `hostssl` (TLS) + rol+password.

## 8. Alternativas descartadas

- **SSH + psql a una réplica física del primario.** La réplica contiene toda la
  PII; los catálogos filtran el esquema; un REVOKE olvidado = brecha. Defensa solo
  por configuración sobre datos presentes. Descartado.
- **Bastion VPS → mismo primario.** Protege la *ruta de red*, no los *datos*: tras
  el túnel hablas con el Postgres completo. Suma gestión de SSH sin aislar nada.
  El bastion sirve para acceso del *equipo* al primario privado, no para terceros.
- **Roles restringidos sobre el mismo primario (sin hub).** Mismo problema de
  catálogos + PII presente. El mecanismo de roles es correcto, pero apuntado al
  **hub saneado**, no al primario.
- **Solo API, sin SQL crudo.** Es la opción más simple y cubre a la mayoría
  (Vía A + endpoints de export masivo). Es el **fallback** si el equipo decide que
  ningún consumidor necesita SQL server-side todavía (ver §9).

## 9. Plan por fases (no sobre-construir)

1. **Ahora, cero infra:** Vía A (API keys, hecho) + endpoints de export masivo
   (`GET /api/public/datasets/reports.csv`) cubren "denme los datos" sin servidor
   nuevo.
2. **Cuando un consumidor concreto necesite SQL crudo:** levantar el hub
   (`hub.tf`), activar `wal_level=logical` (un restart, en el próximo deploy),
   crear la publicación con las listas de columnas de §4, suscribir, exponer 5432
   a su IP.

No se toca `infra/tofu` ni el primario hasta que el equipo apruebe la **lista de
columnas publicables (§4)** — esa lista es la frontera de privacidad completa.

## 10. Checklist de implementación (cuando se apruebe)

- [ ] Equipo valida la lista de columnas publicables (§4).
- [ ] `max_slot_wal_keep_size = 2GB` + alerta de disco en el primario.
- [ ] `wal_level = logical` en el primario (plegar a un deploy/reboot).
- [ ] `hub.tf` + cloud-init del hub + `mapa-hub-fw` con allowlist.
- [ ] DNS `data.terremotovenezuela.app` → IP pública del hub; certificado TLS.
- [ ] `hub_repl` (primario) + `PUBLICATION hub_pub` + `SUBSCRIPTION hub_sub`.
- [ ] Gate de CI §5.6: `infra/db/replicas.manifest.json` +
      `scripts/check-replica-policy.mjs` en `npm run lint` y en el deploy
      (implementar **con** el hub, no antes).
- [ ] Capacidad `data:replica` + flujo para emitir roles `consumer_*` en el hub.
- [ ] Doc de consumidor (string de conexión, `sslmode=verify-full`, tablas y
      columnas disponibles).
- [ ] Actualizar `docs/architecture/architecture.md` y, si toca infra,
      `docs/architecture/despliegue-kubernetes.md`.
