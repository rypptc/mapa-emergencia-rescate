# Hub Postgres VPS (mapa-hub-postgres) — la RÉPLICA PÚBLICA SANEADA (RFC 0006).
#
# Es una SEGUNDA base Postgres, separada del primario (mapa-postgres). Recibe por
# REPLICACIÓN LÓGICA solo las tablas/columnas publicables (sin PII directa de
# secretos/auditoría/federación). Los consumidores externos se conectan por TCP
# 5432 (TLS + rol por consumidor) para correr SQL crudo de solo lectura.
#
# Es un PET (stateful, nunca recreado a la ligera), igual que postgres/valkey:
#   - misma SSH key ops (`mapa-key`) + break-glass → se puede SSH entre cajas.
#   - mismo network privado 10.0.0.0/16 → el primario le replica por IP privada
#     (10.0.1.10 → 10.0.1.12), tráfico que NO toca el firewall (Hetzner deja pasar
#     el privado). El SSH y el 5432 público los gobierna su FIREWALL PROPIO
#     (mapa-hub-fw, ver hub-firewall.tf) — NUNCA mapa-db-fw, que está pegado al
#     primario y abrir 5432 ahí expondría toda la PII.
resource "hcloud_server" "hub_postgres" {
  name        = "mapa-hub-postgres"
  server_type = var.server_type
  image       = var.image
  location    = var.location
  # Misma llave ops que el resto + break-glass si está configurada (concat con la
  # lista del count, igual que el master). Así SSH entre postgres usa la misma key.
  ssh_keys     = concat([hcloud_ssh_key.mapa.id], hcloud_ssh_key.breakglass[*].id)
  firewall_ids = [hcloud_firewall.hub.id]

  user_data = templatefile("${path.module}/cloud-init/hub-postgres.yaml.tftpl", {
    hub_db          = var.hub_db
    hub_admin_user  = var.hub_admin_user
    hub_admin_pass  = var.hub_admin_password
    hub_repl_user   = var.hub_repl_user
    hub_repl_pass   = var.hub_repl_password
    primary_cidr    = "10.0.0.0/16"
    consumer_access = var.hub_consumer_pg_hba
  })

  network {
    network_id = hcloud_network.mapa.id
    ip         = var.hub_private_ip
  }

  labels = { role = "hub-postgres", managed_by = "opentofu" }

  depends_on = [hcloud_network_subnet.mapa]

  lifecycle {
    # Pet: bloquear `tofu destroy`. Para tumbarlo a propósito, quita este bloque.
    prevent_destroy = true
    # cloud-init corre solo en el primer boot; no recrear por editar user_data.
    # ssh_keys: Hetzner solo aplica llaves al CREAR (sus docs); cambiarlas en el
    # server vivo forzaría destruir+recrear → se ignora (se gestionan vía
    # authorized_keys), igual que postgres/valkey/master.
    ignore_changes = [user_data, ssh_keys]
  }
}

# Volumen de datos del hub (PGDATA durable, sobrevive un rebuild del server).
resource "hcloud_volume" "hub_pgdata" {
  name      = "mapa-hub-pgdata"
  size      = var.hub_volume_size
  server_id = hcloud_server.hub_postgres.id
  automount = true
  format    = "ext4"

  lifecycle {
    prevent_destroy = true
  }
}
