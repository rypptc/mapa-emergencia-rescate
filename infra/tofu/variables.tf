variable "hcloud_token" {
  description = "Hetzner Cloud API token (Read & Write). From TF_VAR_hcloud_token."
  type        = string
  sensitive   = true
}

variable "ssh_public_key" {
  description = "SSH public key registered on the servers (mapa_k3s.pub)."
  type        = string
}

# Clave SSH "break-glass" (de respaldo): se guarda OFFLINE (no en .env del laptop
# ni en GitHub secrets) y solo se usa si la clave ops se filtra, para entrar al
# master y revocar la comprometida sin quedar bloqueado. Va en el master (root SSH
# -> kubectl admin vía /etc/rancher/k3s/k3s.yaml). OPCIONAL: "" la desactiva.
# Solo aplica a masters CREADOS tras el apply; el master vivo necesita un append
# manual una vez (Hetzner instala llaves solo en el primer boot).
variable "user_ssh_key" {
  description = "Break-glass SSH public key (offline). Vacío = desactivada."
  type        = string
  default     = ""
}

variable "location" {
  description = "Hetzner location for the stateful servers."
  type        = string
  default     = "hel1"
}

variable "network_zone" {
  description = "Network zone for the private subnet (Helsinki is eu-central)."
  type        = string
  default     = "eu-central"
}

variable "server_type" {
  description = "Server type for Postgres/Valkey (cx23 = 2 vCPU / 4GB)."
  type        = string
  default     = "cx23"
}

variable "image" {
  description = "OS image for the stateful servers."
  type        = string
  default     = "debian-12"
}

# --- Postgres ---
variable "postgres_user" {
  type      = string
  sensitive = true
}
variable "postgres_password" {
  type      = string
  sensitive = true
}
variable "postgres_app_db" {
  type    = string
  default = "app"
}
variable "postgres_imported_db" {
  type    = string
  default = "imported"
}
variable "postgres_volume_size" {
  description = "Data volume size (GB) for Postgres."
  type        = number
  default     = 40
}

# --- Valkey ---
variable "valkey_password" {
  type      = string
  sensitive = true
}

# Static private IPs (so DATABASE_URL/VALKEY_URL are stable and predictable).
variable "postgres_private_ip" {
  type    = string
  default = "10.0.1.10"
}
variable "valkey_private_ip" {
  type    = string
  default = "10.0.1.11"
}

# --- Hub Postgres (réplica pública saneada, RFC 0006) ---
variable "hub_private_ip" {
  description = "IP privada fija del hub (recibe replicación del primario)."
  type        = string
  default     = "10.0.1.12"
}
variable "hub_volume_size" {
  description = "Tamaño (GB) del volumen de datos del hub."
  type        = number
  default     = 40
}
variable "hub_db" {
  description = "Nombre de la base pública en el hub."
  type        = string
  default     = "public_db"
}
variable "hub_repl_user" {
  description = "Rol de replicación del hub (lo usa CREATE SUBSCRIPTION)."
  type        = string
  default     = "hub_repl"
}
variable "hub_repl_password" {
  type      = string
  sensitive = true
}
variable "hub_admin_user" {
  description = "Rol CREATEROLE que usa el backend para crear roles de consumidor."
  type        = string
  default     = "hub_admin"
}
variable "hub_admin_password" {
  type      = string
  sensitive = true
}

# Allowlists del firewall del hub (mapa-hub-fw). Vacío = cerrado a internet.
variable "hub_admin_ips" {
  description = "IPs admin con SSH al hub. Restringe a operadores; evita 0.0.0.0/0."
  type        = list(string)
  default     = []
}
variable "hub_consumer_ips" {
  description = <<-EOT
    Lista blanca de IPs de consumidores externos para 5432 público. Vacía =
    nadie llega al puerto (la replicación privada sigue OK). Se amplía aquí
    (tofu) o vía el backend/API de Hetzner (RFC 0006, modelo B).
  EOT
  type        = list(string)
  default     = []
}
variable "hub_consumer_pg_hba" {
  description = <<-EOT
    Origen para la regla hostssl de consumidores en pg_hba del hub. El firewall
    ya filtra por IP; esto es defensa en profundidad. "0.0.0.0/0" delega el
    control de IP 100% al firewall; o pon un CIDR para doble candado.
  EOT
  type        = string
  default     = "0.0.0.0/0"
}

# --- k3s cluster ---
variable "k3s_token" {
  description = "Shared secret that joins agents to the server. From TF_VAR_k3s_token (openssl rand -hex 32)."
  type        = string
  sensitive   = true
}
variable "k3s_master_private_ip" {
  type    = string
  default = "10.0.1.5"
}
variable "k3s_worker_count" {
  description = <<-EOT
    Workers FIJOS gestionados por tofu. Modelo TOTALMENTE EFÍMERO: default 0 —
    el cluster-autoscaler (infra/k8s/cluster-autoscaler.yaml) es dueño de TODOS
    los workers vía su pool `--nodes=2:5:...` (min=2 piso, max=5 techo), creando
    y destruyendo VPS bajo demanda. Así no se gestionan nodos a mano.
    Pon >0 SOLO si quieres una base fija además del pool del CA (no recomendado).
  EOT
  type        = number
  default     = 0
}
