# Firewall SEPARADO para el hub público (mapa-hub-postgres). DEBE ser propio:
# mapa-db-fw está pegado a los 5 servers (primario con PII incluido), así que un
# 5432 público ahí expondría la base real. Este firewall se pega SOLO al hub.
#
# Recordatorio Hetzner (igual que en firewall.tf): el firewall filtra SOLO tráfico
# público; el privado (10.0.0.0/16) lo bypassea. Por eso:
#   - replicación primario→hub (privada): NO necesita regla aquí. ✅
#   - 5432 público: lo gobierna la regla de abajo (allowlist de consumidores). ✅
#   - 22 (SSH admin): allowlist de admins.
#
# La allowlist de 5432 es la lista BLANCA de IPs de consumidores. Vacía por
# defecto = el puerto NO es alcanzable por nadie en internet (la replicación
# privada sigue funcionando). Se agregan IPs vía `hub_consumer_ips` (tofu) o,
# más adelante, vía el backend llamando a la API de Hetzner (RFC 0006, modelo B).
resource "hcloud_firewall" "hub" {
  name = "mapa-hub-fw"

  # Hetzner EXIGE >=1 source_ip por regla: una lista vacía es rechazada
  # (invalid_input). Por eso cada regla es un bloque `dynamic` que solo existe si
  # su allowlist tiene entradas. Allowlist vacía = NO hay regla = puerto cerrado
  # al mundo (que es justo lo que queremos por defecto en 5432).

  # SSH admin. Restringe a IPs de operador (NO 0.0.0.0/0).
  dynamic "rule" {
    for_each = length(var.hub_admin_ips) > 0 ? [1] : []
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "22"
      source_ips = var.hub_admin_ips
    }
  }

  # Postgres público para consumidores externos. Allowlist explícita; vacía = sin
  # regla = cerrado. TLS + rol-por-consumidor son la 2ª y 3ª capa de defensa. El
  # backend agrega/quita IPs aquí vía la API de Hetzner (RFC 0006).
  dynamic "rule" {
    for_each = length(var.hub_consumer_ips) > 0 ? [1] : []
    content {
      direction  = "in"
      protocol   = "tcp"
      port       = "5432"
      source_ips = var.hub_consumer_ips
    }
  }
}
