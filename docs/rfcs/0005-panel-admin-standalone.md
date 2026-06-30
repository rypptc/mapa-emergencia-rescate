# RFC 0005 — Panel admin como microservicio standalone (3er tier)

Estado: implementado. Continúa el split web/api de
[RFC 0004](0004-autoscaling-y-split-web-api.md) añadiendo un tercer tier.

## Contexto

El panel de administración dejó de ser una ruta dentro del sitio público
(`frontend/app/(admin)`) y pasó a ser un **microservicio Next.js standalone** en
`admin/` (app Next.js plana: `app/` + `src/` + `tests/`, sin monorepo). Lo usan
rescatistas y coordinadores, no el público general, y diverge del sitio público
en layout, navegación y flujos (gestión de roles/usuarios, entrada de datos).

Adaptado del PR #125 (que lo diseñó contra el monolito previo): se reusó el
scaffold/DDD/Result/HttpClient y se reescribió AUTH (motor RBAC con JWT en cookie
httpOnly, no el `x-admin-token`) y DEPLOY (integrado al `deploy-hetzner.yml`
existente, no un workflow aparte).

## Decisión

Un **tercer tier** `admin`, espejo del patrón `web`/`api`:

- **Imagen propia** `…-admin:<sha>` (Dockerfile Next standalone en `admin/`; app
  plana, `server.js` y `.next/static` quedan en la raíz). NO
  se reusa la imagen del frontend: son apps distintas que evolucionan por
  separado (aislamiento de blast-radius en build y deploy).
- **Deployment `admin`** (`tier=admin`, :3000), réplicas bajas (2–6 vía HPA): no
  es tráfico público masivo. Probes a `/api/health` (su BFF, desacoplado de
  upstreams).
- **Service `admin` (LoadBalancer)** → **3er LB Hetzner** `admin-lb`, hostname
  `lb-admin.terremotovenezuela.app`. Un LB por Service (igual que web/api):
  aislamiento total de TLS y blast-radius.
- **HPA `admin`** (CPU 60%, min 2 / max 6).

### Cómo habla con el backend

El navegador llama **same-origin** al BFF del panel (`/api/*` del propio
servicio). El BFF llama al backend por la **red interna** del clúster
(`EMERGENCY_API_URL=http://api.mapa.svc.cluster.local`), reenviando la sesión
como `Authorization: Bearer` (leída de la cookie httpOnly). Así el JWT nunca sale
al navegador y no hace falta tocar CORS del backend.

### Sesión

Cookie httpOnly **host-only** sobre `admin.terremotovenezuela.app`
(`Secure` + `SameSite=Lax`). En el Deployment se fuerza `COOKIE_SECURE=true`
(prod = HTTPS). Sin SSO accidental con el sitio público.

## Despliegue (CI)

Todo vive en `.github/workflows/deploy-hetzner.yml` (NO un workflow aparte):

1. Job `verify-admin` (Node 24): `lint` + `typecheck` + `test` del panel.
   `deploy` depende de `verify` **y** `verify-admin`.
2. Build+push de la imagen `…-admin:<sha>` (build-arg `APP_BUILD_SHA` para el
   anti version-skew; `EMERGENCY_API_URL` NO es build-arg, se inyecta en runtime).
3. `service.yaml` define los TRES Services; `envsubst` rellena
   `${ADMIN_TLS_ANNOTATIONS}` (mismo perfil TLS que web/api).
4. `kubectl set image deployment/admin` + `rollout status` en el loop
   `for tier in web api admin` (cero downtime: `maxUnavailable:0` + readiness).

## Setup manual (una vez, fuera del workflow)

1. **Primer deploy = nuevo LB**: el `Service admin` crea un **3er Load Balancer
   Hetzner** (`admin-lb`, con coste). Toma su IP/hostname:
   `kubectl -n mapa get svc admin`.
2. **DNS en Cloudflare**: crea `admin.terremotovenezuela.app` →
   CNAME a `lb-admin.terremotovenezuela.app` (o A a la IP del LB).
3. **TLS en prod**: el perfil `prod` usa `http-managed-certificate-domains` con
   `$PROD_HOST`. Para que el `admin-lb` obtenga cert de
   `admin.terremotovenezuela.app`, **añade ese hostname a `PROD_HOST`** (lista
   separada por comas: `terremotovenezuela.app,api.…,admin.…`). En `staging`
   (cf-origin) el cert comodín ya lo cubre.
4. **Estáticos en R2 (CDN)**: el workflow sube el `.next/static` del panel a
   `s3://$R2_STATIC_BUCKET/admin/_next/static` (carpeta SEPARADA de la del
   frontend en el mismo bucket — los chunks no se mezclan). El `assetPrefix` del
   panel se deriva en build de `vars.NEXT_PUBLIC_R2_PUBLIC_BASE` + `/admin`, así
   que sin tocar nada extra el panel pide sus estáticos al CDN. Si la base CDN no
   está configurada, el prefijo queda vacío y los sirve el propio pod (los 2 pods
   comparten build-id por `generateBuildId`, así que igual no hay ChunkLoadError).

## Alternativas descartadas

- **Misma imagen que el frontend con flag `ADMIN_ONLY`**: acopla dos apps que
  divergen; un deploy del sitio público arriesgaría la herramienta de rescate.
- **Workflow `deploy-dashboard.yml` aparte** (como en #125): duplica el pipeline;
  preferimos un tier más en el workflow canónico.
- **Compartir un LB / ingress**: el repo no usa ingress; un LB por Service es el
  patrón vigente. Un ingress sería un cambio de infra mayor sin necesidad hoy.

## Invariantes a preservar

- Un LB por Service (no dejar dos Services reclamando `admin-lb`).
- Nunca fijar `health-check-port` (el CCM usa el NodePort; ver runbook).
- Mantener la annotation `hostname` (la rotación de IP del LB no rompe el DNS).
- El placeholder de imagen (`ghcr.io/OWNER/REPO-admin:latest`) debe coincidir
  exacto con el `kubectl set image`.
- Añadir `${ADMIN_TLS_ANNOTATIONS}` al whitelist de `envsubst` (si no, el bloque
  TLS no se sustituye o se corrompe el YAML).
- La cookie de sesión httpOnly nunca se expone a JS (el estado se deriva de
  `/api/auth/me`).
