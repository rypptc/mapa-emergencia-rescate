# Runbook — Réplica pública (hub SQL)

Pasos operativos para levantar la **réplica pública saneada** (RFC 0006): una
segunda Postgres que recibe por replicación lógica solo las tablas publicables y
expone SQL crudo de solo lectura a consumidores externos por TCP 5432.

Estado: la infraestructura (tofu) y el backend ya están en el repo. Este runbook
es la secuencia para activarlo. Hay UN paso que toca el primario en vivo
(`wal_level`), claramente marcado.

> Diseño completo y por qué: `docs/rfcs/0006-hub-replica-sql-publico.md`.

## Por qué estos pasos son MANUALES (no CI/tofu)

Importante para replicar esto en el futuro. Los pasos SQL del primario y la
suscripción NO están automatizados, a propósito, por la arquitectura del repo:

- **El primario `mapa-postgres` es un PET congelado.** Su cloud-init
  (`infra/tofu/cloud-init/postgres.yaml.tftpl`) corrió en el PRIMER boot, hace
  meses, y el server tiene `lifecycle.ignore_changes = [user_data]` — así que
  **tofu NUNCA vuelve a correr su cloud-init**. Editar la plantilla no afecta al
  primario vivo. Por eso `wal_level`, la `PUBLICATION`, el rol `hub_repl` y su
  `pg_hba` se aplican **a mano por SSH** sobre el primario.
- **El workflow de deploy NO toca las DB.** `deploy-hetzner.yml` solo hace
  `docker build` + `kubectl` contra el clúster k3s. Postgres/Valkey/hub son VPS
  FUERA del clúster (pets), inalcanzables por `kubectl`. El workflow no tiene (ni
  debe tener) SSH a esas cajas.
- **Lo que SÍ es automático:** crear el hub (`tofu apply` de `hub.tf`, manual
  pero declarativo), el cloud-init del HUB (crea `public_db`, roles `hub_repl`/
  `hub_admin`, ssl, read-only, su pg_hba), la migración `0011` + el seed
  (`mirror:manage`, flag super admin) y el wiring de los secrets `HUB_*` al
  backend — todo eso lo hace el deploy.

> ⚠️ **`hub_repl` se crea en LOS DOS lados** y es fácil de olvidar:
> - en el HUB lo crea su cloud-init (es el rol con el que el SUBSCRIPTION se
>   conecta al primario);
> - en el PRIMARIO hay que crearlo a mano (es el rol que el primario AUTORIZA
>   para la replicación) — con la MISMA password (`hub_repl_password`).
> Si falta en el primario, la suscripción falla con "role does not exist" /
> auth. Ver §2.

> **Para una réplica futura (otro hub):** repite `tofu apply` con otro
> `hub_private_ip`/nombre, repite §2–§4 con esa IP, y agrega su
> `CREATE SUBSCRIPTION`. El `wal_level` del primario YA está en `logical` (es de
> una sola vez), así que ese paso se SALTA — sin restart. Las llaves SSH y la red
> privada se reusan.

## Estado actual de ESTA réplica (lo ya aplicado a mano, 2026-06-29)

Registro de lo hecho manualmente en la primera puesta en marcha, para auditoría
y para saber qué falta. Valores de IPs/IDs (no secretos):

- **Hub VPS:** `mapa-hub-postgres`, público `46.62.243.66`, privado `10.0.1.12`.
  Firewall `mapa-hub-fw` id **11218772** (SSH abierto a la IP admin; 5432 cerrado
  al mundo hasta que un consumidor lo abra). Volumen `mapa-hub-pgdata`. → `hub.tf`.
- **GitHub secrets seteados:** `HUB_ADMIN_DATABASE_URL`, `HUB_DB_NAME`,
  `HUB_PUBLIC_HOST`, `HUB_FIREWALL_ID` (+ `HCLOUD_TOKEN` ya existía).
- **Primario (`mapa-postgres`, 65.109.128.107):** ✅ `wal_level=logical`,
  ✅ `max_slot_wal_keep_size=2GB` (restart aplicado, ~2,5 s, API recuperó),
  ✅ `PUBLICATION hub_pub` (11 tablas), ✅ rol `hub_repl` + ✅ `pg_hba` (replication
  + app desde 10.0.0.0/16).
- **Hub:** ✅ `public_db`, roles `hub_repl`/`hub_admin`, ssl, read-only (cloud-init).
- **FALTA:** ⬜ crear las 11 tablas publicadas en el hub (§3), ⬜ `CREATE
  SUBSCRIPTION` (§3), ⬜ `GRANT ... TO hub_admin WITH GRANT OPTION` (§4),
  ⬜ DNS `data.terremotovenezuela.app` → `46.62.243.66`. Sin esto NO fluye
  replicación todavía.

## 0. Resumen de la arquitectura

```
Primario (mapa-postgres, PII completa)  ──repl. lógica (red privada)──▶  Hub (mapa-hub-postgres)
   wal_level=logical + PUBLICATION hub_pub                                   solo tablas publicables
                                                                            5432 público (allowlist)
Backend (super admin, mirror:manage) ── crea rol consumer_* + abre IP en mapa-hub-fw (API Hetzner)
Consumidor ── psql host=data.… sslmode=verify-full user=consumer_… (read-only)
```

## 1. Provisionar el hub (tofu)

```bash
cd infra/tofu
# Variables nuevas (ver terraform.tfvars.example):
#   hub_repl_password, hub_admin_password  (openssl rand -hex 32)
#   hub_admin_ips    = ["TU.IP/32"]        # SSH admin al hub
#   hub_consumer_ips = []                   # VACÍO al inicio: 5432 cerrado al mundo
tofu plan   -target=hcloud_firewall.hub -target=hcloud_server.hub_postgres -target=hcloud_volume.hub_pgdata
tofu apply  -target=hcloud_firewall.hub -target=hcloud_server.hub_postgres -target=hcloud_volume.hub_pgdata
```

cloud-init crea: `public_db`, TLS (`ssl=on`), `default_transaction_read_only=on`,
el rol `hub_repl` (replicación) y `hub_admin` (CREATEROLE para el backend), y el
`pg_hba` con `hostssl` para consumidores. Anota los outputs:

```bash
tofu output hub_public_ip          # apunta data.terremotovenezuela.app aquí (DNS)
tofu output -raw hub_subscription_conn   # CONNECTION para el SUBSCRIPTION
tofu output -raw hub_admin_url           # HUB_ADMIN_DATABASE_URL del backend
# id del firewall mapa-hub-fw (para HUB_FIREWALL_ID del backend):
#   tofu state show hcloud_firewall.hub | grep '^\s*id'
```

## 2. Habilitar replicación lógica en el primario ⚠️ TOCA PROD

`wal_level` es parámetro `postmaster`: cambiarlo requiere **un restart** del
primario (PG15). Medido: Postgres vuelve en ~0,6 s y el backend no devuelve error
(el pool reconecta). Plegar al próximo deploy/reboot rutinario.

```bash
ssh root@<mapa-postgres>   # misma key ops
sudo -u postgres psql -d app -c "ALTER SYSTEM SET wal_level='logical';"
sudo -u postgres psql -d app -c "ALTER SYSTEM SET max_slot_wal_keep_size='2GB';"  # cota: un hub caído nunca llena el disco del primario
systemctl restart postgresql
sudo -u postgres psql -d app -c "SHOW wal_level;"   # -> logical
```

Crear el rol de replicación + la publicación (RFC 0006 §4 — tablas publicables):

```sql
-- en el PRIMARIO, base app
CREATE ROLE hub_repl WITH LOGIN REPLICATION PASSWORD '<hub_repl_password>';
GRANT SELECT ON
  earthquakes, reports, hospitals, hospital_supply_statuses,
  hospital_supply_needs, donations, missing_persons, unidentified_persons,
  hospital_patients, contact_messages, report_confirmations
TO hub_repl;

CREATE PUBLICATION hub_pub FOR TABLE
  earthquakes, reports, hospitals, hospital_supply_statuses,
  hospital_supply_needs,
  donations            (id, name, amount_usd, created_at, status),   -- sin ip_hash/user_agent
  missing_persons, unidentified_persons, hospital_patients,
  contact_messages     (id, name, email, subject, message, read, created_at),  -- sin ip_hash
  report_confirmations (report_id, created_at);                                 -- sin ip_hash
```

`pg_hba` del primario debe permitir replicación desde la IP privada del hub
(`10.0.1.12`). Si el cloud-init del primario no lo incluyó, añadir y recargar:

```
host    replication   hub_repl   10.0.1.12/32   scram-sha-256
host    app           hub_repl   10.0.1.12/32   scram-sha-256
```
```bash
sudo -u postgres psql -c "SELECT pg_reload_conf();"
```

## 3. Migrar el esquema del hub + suscribir

El hub necesita las tablas publicadas ANTES de suscribir (la replicación lógica
no propaga DDL). Corre las MISMAS migraciones Drizzle apuntando al hub:

```bash
# desde un pod/host con acceso privado al hub:
DATABASE_URL="postgres://mapa_app:<pw>@10.0.1.12:5432/public_db" \
  MIGRATIONS_DIR=infra/db/migrations npm --prefix backend run migrate
```

> Solo necesitas las tablas publicadas; migrar todo el esquema también vale (las
> tablas no publicadas quedan vacías y nunca reciben datos). Lo importante: las
> publicadas deben tener TODAS las columnas publicadas (ver §5.5 de la RFC).

Suscribir (jala copia inicial + streaming):

```sql
-- en el HUB, base public_db
CREATE SUBSCRIPTION hub_sub
  CONNECTION 'host=10.0.1.10 port=5432 dbname=app user=hub_repl password=<hub_repl_password> sslmode=disable'
  PUBLICATION hub_pub;

-- verificar:
SELECT srrelid::regclass, srsubstate FROM pg_subscription_rel;   -- todas en 'r'
```

## 4. Conceder al rol admin del backend permiso para hacer GRANT

`hub_admin` (CREATEROLE) crea roles de consumidor y les hace `GRANT SELECT`. Para
poder otorgar SELECT debe tenerlo con grant option sobre las tablas publicadas:

```sql
-- en el HUB, public_db
GRANT SELECT ON
  earthquakes, reports, hospitals, hospital_supply_statuses,
  hospital_supply_needs, donations, missing_persons, unidentified_persons,
  hospital_patients, contact_messages, report_confirmations
TO hub_admin WITH GRANT OPTION;
GRANT USAGE ON SCHEMA public TO hub_admin WITH GRANT OPTION;
```

## 5. Configurar el backend

Secrets/env (k8s `secret.yaml` + GitHub secrets):

```
HUB_ADMIN_DATABASE_URL = <output hub_admin_url>     # red privada al hub
HUB_PUBLIC_HOST        = data.terremotovenezuela.app
HUB_DB_NAME            = public_db
HCLOUD_TOKEN           = <token Hetzner, idealmente scoped a firewalls>
HUB_FIREWALL_ID        = <id numérico de mapa-hub-fw>
```

Sin estas, la gestión de réplica queda **desactivada** (el endpoint responde 503),
sin romper el resto del backend.

## 6. Emitir acceso a un consumidor (super admin)

En el panel admin → **Réplica pública** (visible solo a super admins). El flujo:

1. "Usar la mía" detecta la IP, o pega la IP/CIDR del consumidor.
2. "Emitir credencial" → el backend: abre la IP en `mapa-hub-fw` (API Hetzner),
   crea `consumer_<id>` con password en el hub, devuelve la conexión **una vez**.
3. Entrega `host/user/password` al consumidor. Conecta:

```bash
psql "host=data.terremotovenezuela.app port=5432 dbname=public_db user=consumer_… sslmode=verify-full"
```

Revocar (botón "Revocar"): `DROP ROLE` en el hub + cierra la IP en el firewall +
soft-delete. Idempotente.

## 7. Operación / vigilancia

- **WAL del primario:** monitorea `pg_replication_slots.wal_status` y disco. El
  `max_slot_wal_keep_size=2GB` evita que un hub caído llene el primario (se
  invalida el slot; el hub re-sincroniza).
- **Tabla nueva publicable:** ver RFC 0006 §5.5 (runbook de 4 pasos: hub migra →
  GRANT a hub_repl → ALTER PUBLICATION ADD TABLE → REFRESH) y §5.6 (gate de CI).
- **Mirror caído:** no afecta al primario (replicación desacoplada). Reconstruir
  el hub = re-suscribir.
