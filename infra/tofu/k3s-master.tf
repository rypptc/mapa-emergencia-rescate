# k3s control-plane node. cloud-init installs k3s server (see template). Joins
# the private network at a fixed IP so workers/autoscaler can find it.
resource "hcloud_server" "k3s_master" {
  name        = "mapa-master"
  server_type = var.server_type
  image       = var.image
  location    = var.location
  # Llave ops + (si está configurada) la break-glass. concat con la lista del
  # count: si user_ssh_key="" el recurso breakglass no existe y la lista queda
  # solo con la ops. Aplica a masters CREADOS tras el apply (ver ignore_changes).
  ssh_keys     = concat([hcloud_ssh_key.mapa.id], hcloud_ssh_key.breakglass[*].id)
  firewall_ids = [hcloud_firewall.db.id]

  user_data = templatefile("${path.module}/cloud-init/k3s-master.yaml.tftpl", {
    k3s_token         = var.k3s_token
    master_private_ip = var.k3s_master_private_ip
    flannel_iface     = "enp7s0" # Hetzner private NIC on cx-line; verify on first boot
    hcloud_token      = var.hcloud_token
    network_name      = hcloud_network.mapa.name
  })

  network {
    network_id = hcloud_network.mapa.id
    ip         = var.k3s_master_private_ip
  }

  labels = { role = "k3s-master", managed_by = "opentofu" }

  depends_on = [hcloud_network_subnet.mapa]

  lifecycle {
    # cloud-init corre una vez; no recrear por editar user_data. ssh_keys también
    # se ignora: Hetzner SOLO aplica llaves al CREAR el server (confirmado en sus
    # docs), así que cambiar la lista en el master VIVO haría que tofu quiera
    # destruir+recrear el control-plane — jamás. La break-glass entra sola en un
    # master nuevo; en el vivo se añade a authorized_keys con un append manual.
    ignore_changes = [user_data, ssh_keys]
  }
}
