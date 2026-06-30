# Ramas, ruleset y flujo de promoción (staging → main)

Modelo de promoción en dos etapas, con despliegue automático por rama:

```
feature/*  --PR-->  staging  --PR-->  main
                      |                  |
              deploy-staging.yml   deploy-hetzner.yml
              (VPS Debian único)   (k3s / prod)
```

- A `staging` y `main` **no se hace push directo**: todo entra por PR.
- A `main` **solo se llega por PR DESDE `staging`** (promoción).
- Merge a `staging` → despliega staging. Merge a `main` → despliega prod.
  Espeja el modelo de prod (push a `main` despliega) en el lado de staging.

## Ruleset (configuración en GitHub, no es un archivo del repo)

Un único ruleset **"proteger main"** (id `18196160`) protege **ambas** ramas con
las mismas reglas estrictas. Se aplica vía API; queda registrado aquí para poder
reproducirlo.

- **Targets:** `refs/heads/main`, `refs/heads/staging`
- **Bypass:** rol **Repository admin** (`RepositoryRole` id `5`), modo `always`.
  Esto es lo que deja a los admins (mantenedores) mergear sus PRs sin fricción,
  igual que antes. GitHub no permite que apruebes tu PROPIO PR, así que
  "auto-aprobar" = el admin **salta** el requisito de aprobación al mergear.
- **Reglas:** require PR (1 aprobación + code-owner review), required linear
  history, bloquear borrado, bloquear force-push (`non_fast_forward`).
- **Status checks requeridos:** `Build & Test` y `pr-source-guard`.

### Re-aplicar / inspeccionar el ruleset

```bash
FULL=$(gh repo view --json nameWithOwner -q .nameWithOwner)
# leer
gh api "repos/$FULL/rulesets/18196160"
# editar: baja el JSON, modifica conditions/rules/bypass_actors y súbelo
gh api -X PUT "repos/$FULL/rulesets/18196160" --input ruleset.json
```

> Nota: usa la ruta `repos/<owner>/<repo>/...` completa. La forma `:owner/:repo`
> devuelve un 307 en PUT con cuerpo y `gh` no sigue el redirect.

## El guard de origen (`pr-source-guard`)

GitHub **no** puede restringir la rama ORIGEN de un PR en rulesets (limitación
conocida: <https://github.com/orgs/community/discussions/57404>). Por eso el
"solo desde staging" se hace con un status check requerido:
[.github/workflows/pr-source-guard.yml](../../.github/workflows/pr-source-guard.yml)
corre **solo en PRs hacia `main`** y falla si `head_ref != staging`.

Gotcha: un check requerido que se SALTA queda "pending" y bloquea el merge para
siempre. Por eso el guard no lleva filtros de `paths` (corre en todo PR a main) y
su job tiene nombre único (el ruleset matchea por contexto exacto).

## Despliegue por rama

- `staging` → [.github/workflows/deploy-staging.yml](../../.github/workflows/deploy-staging.yml)
  (push a `staging` + `workflow_dispatch`). VPS Debian único: rsync + ssh +
  `docker compose -f docker-compose.staging.yml`. Ver
  [replica-publica-hub.md](replica-publica-hub.md) para qué NO va a staging (el
  hub/réplica queda excluido).
- `main` → [.github/workflows/deploy-hetzner.yml](../../.github/workflows/deploy-hetzner.yml)
  (push a `main` + `workflow_dispatch`). El job `deploy` usa el environment
  `production-hetzner`.

## Crear la rama staging (una vez)

Tras mergear estos cambios a `main`:

```bash
git fetch origin
git push origin origin/main:refs/heads/staging   # crea staging desde main
```

A partir de ahí, abre PRs de `feature/*` contra `staging`, y PRs de `staging`
contra `main` para promocionar a prod.
