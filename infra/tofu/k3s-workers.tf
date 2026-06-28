# Workers FIJOS gestionados por tofu. MODELO EFÍMERO: k3s_worker_count default 0
# → el cluster-autoscaler (infra/k8s/cluster-autoscaler.yaml) es dueño de TODOS
# los workers. Con count=0 este recurso no crea nada.
#
# ⚠️ ORDEN DE MIGRACIÓN (evitar outage): NO bajes el count a 0 hasta que el CA
# esté desplegado, sano y manteniendo su piso (min=2). Si destruyes los workers
# fijos ANTES de que el CA tenga nodos vivos, el clúster se queda sin workers
# hasta que el CA aprovisione (2-5 min) — los pods quedan Pending mientras tanto.
# Secuencia segura: (1) desplegar CA con max para crear su pool, (2) confirmar
# 2 nodos del pool Ready, (3) recién entonces aplicar count=0. Ver el runbook en
# docs/rfcs/0004.
resource "hcloud_server" "k3s_worker" {
  count        = var.k3s_worker_count
  name         = "mapa-worker-${count.index + 1}"
  server_type  = var.server_type
  image        = var.image
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.mapa.id]
  firewall_ids = [hcloud_firewall.db.id]

  user_data = templatefile("${path.module}/cloud-init/k3s-agent.yaml.tftpl", {
    k3s_token         = var.k3s_token
    master_private_ip = var.k3s_master_private_ip
    flannel_iface     = "enp7s0"
  })

  network {
    network_id = hcloud_network.mapa.id
    # workers at 10.0.1.20, .21, ... (autoscaler nodes get DHCP elsewhere)
    ip = "10.0.1.${20 + count.index}"
  }

  labels = { role = "k3s-worker", managed_by = "opentofu" }

  depends_on = [hcloud_server.k3s_master]

  lifecycle {
    ignore_changes = [user_data]
  }
}
