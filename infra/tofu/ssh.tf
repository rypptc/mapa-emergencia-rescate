# The SSH public key placed on every server. The matching private key stays on
# your machine / in the SSH_PRIVATE_KEY GitHub secret — never here.
resource "hcloud_ssh_key" "mapa" {
  name       = "mapa-key"
  public_key = var.ssh_public_key
}

# Clave "break-glass" (de respaldo, offline). Solo se registra si user_ssh_key
# tiene valor (count). Va en el master para recuperar acceso si la clave ops se
# filtra. Importante (limitación de Hetzner, confirmada en sus docs): las
# ssh_keys de un servidor SOLO se aplican al CREARLO; cambiarlas en un server
# vivo haría que tofu quiera destruir+recrear. Por eso el master usa
# lifecycle.ignore_changes=[ssh_keys] (ver k3s-master.tf): esta llave entra
# automáticamente en masters NUEVOS, y en el master vivo se añade UNA vez a mano
# (append a authorized_keys) — nunca recreamos el control-plane.
resource "hcloud_ssh_key" "breakglass" {
  count      = var.user_ssh_key == "" ? 0 : 1
  name       = "mapa-breakglass"
  public_key = var.user_ssh_key
}
