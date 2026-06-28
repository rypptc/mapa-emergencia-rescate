# RFC 0004 — Nodos efímeros (cluster-autoscaler) + split web/api

Estado: propuesto
Fecha: 2026-06-28
Relacionado: `infra/k8s/{deployment,service,hpa,cluster-autoscaler}.yaml`,
`infra/tofu/{k3s-workers,variables}.tf`, `.github/workflows/deploy-hetzner.yml`.

## 0. Objetivo

Dos cambios para escalar a ~1M usuarios/día con consumidores externos de API:

1. **Nodos totalmente efímeros.** El cluster-autoscaler (CA) de Hetzner es dueño
   de TODOS los workers vía un pool `--nodes=2:5` (piso 2, techo 5). Crea VPS bajo
   demanda y los destruye al quedar ociosos. Cero gestión manual de nodos. No hay
   workers fijos en tofu (`k3s_worker_count=0`).
2. **Split web/api** (mismo image, dos Deployments + dos LB). Aísla el blast
   radius: una ráfaga de un consumidor de API no ahoga el render del front. HPA
   independiente por tier.

## 1. Arquitectura resultante

```
Hetzner LB "mapa-lb"      → Service web → Deployment web (tier=web)  → terremoto…
Hetzner LB "mapa-api-lb"  → Service api → Deployment api (tier=api)  → api.terremoto…
                            (mismo image; api = /api para terceros)
                          → Deployment migrate-worker (BullMQ, sin LB)
master (fijo, tofu)       → control-plane + CA + coredns/HCCM/metrics
workers (efímeros, CA)    → pool mapa-pool, 2..5 VPS cx23, IP privada+pública
Postgres/Valkey (tofu)    → VPS separados, FUERA del clúster (el CA NO los toca)
```

- HPA escala **pods** (web 3..20, api 3..30, CPU 60%). CA escala **nodos**.
- El CA corre en el **master** (siempre vivo) → arranca aunque haya 0 workers.

## 2. Por qué es seguro (no rompe prod)

- **Datos intocables:** Postgres/Valkey son VPS aparte, no nodos k8s. El CA solo
  gestiona su pool `mapa-pool`. Imposible que toque la base.
- **Piso mantenido:** `--nodes=2:...` mantiene 2 workers siempre vivos.
- **Scale-down con frenos:** `scale-down-unneeded-time=10m`,
  `scale-down-delay-after-add=10m`, `skip-nodes-with-system-pods=true`. Un nodo
  solo muere tras 10 min ocioso y drenando con desalojo graceful.
- **Zero-downtime en rollout:** `maxUnavailable:0` + `maxSurge:1` +
  `readinessProbe /api/readyz` + `preStop sleep`. El pod nuevo debe estar Ready
  ANTES de quitar el viejo; el LB deja de enrutar al viejo (readiness falla en
  preStop) y solo manda tráfico al nuevo. **El deploy redirige a los VPS/pods
  nuevos y drena los viejos** — exactamente el requisito.
- **Egress de nodos nuevos:** IP pública ON (como los workers actuales; no hay
  NAT gateway). Necesario para `get.k3s.io` + pull de imágenes. Firewall
  `mapa-db-fw` solo abre 22/6443 al público.

## 3. Riesgo real: el ORDEN de la migración

Hay DOS cutovers delicados. Hacerlos en orden o habrá outage.

### 3a. Cutover de Deployment/Service viejo (`app`) → `web`+`api`

`kubectl apply` NO borra el `app` viejo. Tras el primer deploy coexistirán
`app` (viejo) + `web`+`api` (nuevos) y DOS/ TRES LB. Pasos:

1. Deploy normal → crea `web`+`api` Deployments + Services + sus LB. `app` sigue
   vivo sirviendo por su LB viejo (sin downtime).
2. Verifica que `web` y `api` están Ready y sus LB responden (curl al healthz por
   la IP del LB nuevo).
3. Apunta el DNS de `terremoto…` al LB `mapa-lb` (web) — si cambió la IP. (Si el
   LB conserva nombre/IP, no hace falta.)
4. Apunta `api.terremoto…` al LB `mapa-api-lb`.
5. Recién entonces borra lo viejo:
   `kubectl -n mapa delete deploy app && kubectl -n mapa delete svc app`
   (esto destruye el LB viejo). NUNCA antes de validar el nuevo.

### 3b. Cutover de workers fijos → efímeros (CA)

`k3s_worker_count=0` en tofu DESTRUIRÍA `mapa-worker-1/2`. Si el CA no tiene
nodos aún, el clúster se queda sin workers. Orden seguro:

1. Deploy el CA con su pool (`--nodes=2:5`). Como ya hay 2 workers fijos, el CA
   ve el piso cubierto y NO crea nada todavía (o crea según necesidad real).
2. Para PROBAR que el CA puede crear nodos sin riesgo: temporalmente fija el
   pool a `--nodes=2:5` y genera presión (o baja un worker fijo manualmente y
   observa que el CA repone). Confirma que un nodo `mapa-pool` queda Ready.
3. Recién entonces `tofu apply` con `k3s_worker_count=0`: tofu destruye los 2
   workers fijos; sus pods se reprograman; el CA, al ver pods Pending y su piso
   sin cumplir, levanta 2 nodos del pool. Hay una ventana de 2-5 min — hazlo en
   bajo tráfico la primera vez, o sube el piso del CA a 2 ANTES de destruir los
   fijos (así el CA ya tiene 2 vivos cuando los fijos mueren → sin ventana).

   **Recomendado:** sube el piso del CA y espera a que existan 2 nodos del pool
   ANTES de bajar `k3s_worker_count` a 0. Solapamiento = cero ventana.

## 4. Rollout 100% seguro (resumen ejecutable)

1. Merge → deploy. Crea web/api/HPA/CA (con secret) + LB nuevos. `app` viejo
   intacto. **Sin downtime.**
2. Validar web/api por sus LB. Validar que el CA pod corre en el master y lee la
   config (logs: `kubectl -n kube-system logs deploy/cluster-autoscaler`).
3. Dejar que el CA mantenga su piso de 2 nodos `mapa-pool` (coexisten con los 2
   fijos un rato → 4 workers, sin problema).
4. DNS: `terremoto…`→ web LB, `api.terremoto…`→ api LB.
5. `tofu apply` con `k3s_worker_count=0` (con el solapamiento del paso 3, los
   fijos se van sin ventana).
6. `kubectl delete deploy/svc app` (mata el LB viejo). Fin.

Rollback en cualquier punto: el `app` viejo + sus workers fijos siguen ahí hasta
el paso 5/6, así que se puede abortar sin pérdida.

## 5. TLS / DNS del tier api (Cloudflare, NO Hetzner managed)

El TLS de prod lo termina **Cloudflare** (proxied, naranja), no el LB. La cadena
real hoy para `terremotovenezuela.app`:

```
Browser ─(TLS edge CF)→ Cloudflare ─(TLS origin cf-origin-dreamit)→ Hetzner LB app
```

El LB lleva el Cloudflare **Origin cert** (`cf-origin-dreamit`, *.dreamit.software);
en modo Full, CF→origin acepta ese cert sin validar el hostname. Por eso el LB de
api usa EL MISMO perfil que web (no un cert managed de Hetzner, no `API_HOST`).

**Para exponer `api.terremotovenezuela.app` (en Cloudflare):**
1. Deploy → se crea el LB `mapa-api-lb` con su IP.
2. En Cloudflare DNS: registro **A `api` → IP del LB `mapa-api-lb`**, **Proxied
   (naranja)**.
3. Listo: CF termina TLS para `api.` y proxea al LB de api. Sin secretos nuevos,
   sin cert managed.

(Alternativa sin subdominio: los consumidores externos siguen usando
`terremotovenezuela.app/api` — pero eso vuelve a mezclar el tráfico en el LB de
web. El subdominio + LB aparte es lo que da el aislamiento; por eso se recomienda.)

## 6. Decisión: 2 LB (no Ingress)

Con SOLO dos servicios externos (web + api), la práctica recomendada es un
LoadBalancer por servicio (más simple, sin componentes nuevos). El argumento de
"Ingress para ahorrar" aplica a decenas de servicios; aquí el costo extra es ~€6/mo
de un segundo LB, mucho menos que la superficie operativa de instalar y mantener
un Ingress controller (no tenemos ninguno hoy) + reconfigurar TLS. El aislamiento
(API no ahoga web) lo dan igual los pods separados. Revisitar Ingress solo si
crecemos a muchos servicios expuestos.

## 7. Otras decisiones / pendientes

- **Imagen del CA** pin `v1.36.0` (minor del clúster). Bumpear junto con k3s.
- **Techo del pool** `max=5` (cx23). Subir si los picos de sismo lo piden (solo
  cuestan cuando existen).
- El paso "Apply manifests" mantiene la rama `prod` (cert managed de Hetzner) por
  si algún día se deja de usar Cloudflare; hoy el deploy corre con perfil
  `cf-origin-dreamit` (TARGET distinto de prod), igual que el LB `app` actual.
- **DEUDA TÉCNICA (tarea aparte) — limpiar el cert de origen:** hoy el LB usa el
  Cloudflare Origin cert `cf-origin-dreamit` (*.dreamit.software, dominio AJENO).
  Funciona porque Cloudflare está en modo Full (no-strict, no valida el hostname
  del origen). Limpieza recomendada cuando haya holgura: emitir un Cloudflare
  Origin cert para `*.terremotovenezuela.app`, ponerlo en AMBOS LB, y pasar a Full
  (strict). No urgente; no bloquea este trabajo. El cert managed de Hetzner para
  terremotovenezuela.app existe pero NO se usa (se puede borrar o dejar).
