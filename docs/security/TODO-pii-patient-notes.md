# TODO de seguridad — fuga de PII en pacientes (`notes`) sin autenticación

> Hallazgo de la auditoría de seguridad del 2026-06-28. Severidad **MEDIA-ALTA**,
> confianza 7/10. Contexto humanitario: las `notes` contienen cédula y datos
> médicos de personas afectadas por el terremoto. Esta es la deuda concreta a
> cerrar; el resto de la superficie auditada quedó limpia (ver §"Contexto").

## El problema

`GET /api/hospitals/[id]/patients`
([app/api/hospitals/[id]/patients/route.ts:95-106](../../app/api/hospitals/%5Bid%5D/patients/route.ts#L95-L106))
es **público, sin auth y sin rate-limit**, y devuelve `listPatients()` mapeado
con `rowToPatient` ([lib/hospitals.ts](../../lib/hospitals.ts)), que serializa el
registro completo **incluyendo `notes` y `contact` sin redactar**.

- `notes` es texto libre que **contiene cédula (documento de identidad) y detalle
  médico** — lo confirma el propio código: `searchPatients` extrae los dígitos de
  la cédula *de las notas* con `REGEXP_REPLACE(p.notes, '[^0-9]', '')`.
- `contact` es el teléfono de la familia.
- El `POST` de este mismo archivo **sí** tiene `checkRateLimit`; el `GET` no.

### Camino de explotación

1. Un anónimo llama al público `GET /api/hospitals` → obtiene todos los `id`.
2. Itera `GET /api/hospitals/<id>/patients` para cada hospital.
3. Cosecha el roster completo de cada paciente con **notas médicas + cédula +
   teléfono**, en todos los hospitales, sin auth y sin throttle que lo frene.

### El matiz (por qué 7 y no 9)

El proyecto decidió **a propósito y documentado** que el **contacto** del
paciente es público (decisión C-1: "las familias optan por ser contactables",
ver [app/api/patients/search/route.ts](../../app/api/patients/search/route.ts)).
Así que `name`/`status`/`contact` públicos son por diseño. Lo que **no** es
defendible es exponer las `notes` crudas (cédula + médico) sin auth y sin
rate-limit. La ruta hermana de búsqueda pública al menos limita la búsqueda por
cédula y aplica rate-limit; esta ruta no hace ninguna de las dos.

## Mitigación parcial aplicada (#160, ingesta de pacientes)

El PR de ingesta de pacientes (#160) NO propaga las `notes` crudas del lote al
paciente final: `applyImport` crea el paciente con `notes: ""`. Esto evita que la
importación **agrave** esta fuga (una cédula/nota médica del input no llega al
campo público). El dato crudo sigue confinado en `raw_data` (staging restringido).

Es una **mitigación temporal**, no el fix de raíz: la lectura pública sigue
devolviendo `notes` para pacientes creados por otras vías (formulario admin, etc.).
La corrección de abajo sigue pendiente. Pendiente de decidir con el maintainer: si
los pacientes importados deben conservar notas en un campo restringido (estilo
`public_hospitalized_patients` de #71 en venezuela-ayuda) en vez de vaciarlas.

## La corrección

- [ ] **Proyección pública sin `notes`.** En la ruta pública, mapear los
      pacientes por un DTO que **omita `notes`** (y revisar si `contact` debe
      seguir o también gatearse). Devolver el registro completo (con `notes`) solo
      cuando el caller sea admin o POC del hospital
      (`isAdminRequest` / `isHospitalSupplyWriteRequest`).
      → Espejo de la postura `publicSafe` que ya usa `/api/patients/search`.
- [ ] **Rate-limit en el GET.** Añadir el mismo `checkRateLimit(clientIp(...))`
      que ya tiene el `POST` de este archivo, para frenar el scraping masivo.
- [ ] **Swagger.** Actualizar el bloque `@swagger` del `GET` para reflejar el DTO
      público (sin `notes`) y, si aplica, un nuevo modelo `PublicHospitalPatient`
      en `lib/swagger.ts`.
- [ ] **Test.** Un test que verifique que el GET anónimo NO devuelve `notes`
      (y que admin/POC sí), y que el rate-limit dispara 429.

## Contexto (resto de la auditoría: limpio)

El resto de la superficie quedó bien endurecida y **no** requiere acción:
comparación de tokens en tiempo constante (`safeEqual`), SQL parametrizado en
todos lados (los únicos `sql.raw` operan sobre listas de columnas fijas),
allowlist de DTO que excluye `ip_hash`/`user_agent`, `hashIp` en toda IP
persistida, allowlist cerrada de MIME de imagen (rechaza svg/gif/html), auth por
header `x-admin-token` (sin CSRF), sin `dangerouslySetInnerHTML` sobre datos de
usuario, sin SSRF (hosts fijos), sin secretos hardcodeados, sin bypass de TLS.
