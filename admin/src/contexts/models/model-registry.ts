/**
 * Registro de los modelos administrables (read-only en F1).
 *
 * Fuente de verdad ÚNICA del dashboard para: el path del backend
 * (/api/public/<path>), la capacidad que lo gatea (<path>:read), la etiqueta de
 * navegación y las columnas a mostrar. Espeja PUBLIC_RESOURCES del backend.
 *
 * Añadir un modelo nuevo = una entrada aquí (YAGNI: sin archivos por modelo
 * mientras la vista sea una tabla read-only genérica; cuando un modelo necesite
 * lógica de dominio propia, se extrae a su bounded-context dedicado).
 */

export interface ModelColumn {
  /** Clave del campo en el DTO del backend. */
  key: string;
  /** Encabezado visible. */
  label: string;
}

export interface ModelConfig {
  /** Segmento de ruta: /api/public/<path> y /[path] en el dashboard. */
  path: string;
  /** Etiqueta de navegación (es). */
  label: string;
  /** Capacidad de lectura que lo gatea. */
  readCapability: string;
  /** Columnas a renderizar (las que existan en el DTO; el resto se ignora). */
  columns: ModelColumn[];
}

// Orden = orden en la navegación.
export const MODELS = [
  {
    path: "reports",
    label: "Reportes",
    readCapability: "report:read",
    columns: [
      { key: "id", label: "ID" },
      { key: "type", label: "Tipo" },
      { key: "place", label: "Lugar" },
      { key: "affected", label: "Afectados" },
      { key: "confirmations", label: "Confirmaciones" },
    ],
  },
  {
    path: "missing",
    label: "Desaparecidos",
    readCapability: "missing:read",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Nombre" },
      { key: "place", label: "Lugar" },
      { key: "status", label: "Estado" },
    ],
  },
  {
    path: "hospitals",
    label: "Hospitales",
    readCapability: "hospital:read",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Nombre" },
      { key: "place", label: "Lugar" },
    ],
  },
  {
    path: "patients",
    label: "Pacientes",
    readCapability: "patient:read",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Nombre" },
      { key: "hospitalId", label: "Hospital" },
      { key: "status", label: "Estado" },
    ],
  },
  {
    path: "donations",
    label: "Donaciones",
    readCapability: "donation:read",
    columns: [
      { key: "id", label: "ID" },
      { key: "title", label: "Título" },
      { key: "category", label: "Categoría" },
    ],
  },
  {
    path: "chat",
    label: "Chat",
    readCapability: "chat:read",
    columns: [
      { key: "id", label: "ID" },
      { key: "author", label: "Autor" },
      { key: "message", label: "Mensaje" },
    ],
  },
  {
    path: "contact",
    label: "Contacto",
    readCapability: "contact:read",
    columns: [
      { key: "id", label: "ID" },
      { key: "name", label: "Nombre" },
      { key: "subject", label: "Asunto" },
    ],
  },
] as const satisfies readonly ModelConfig[];

export type ModelPath = (typeof MODELS)[number]["path"];

export function getModel(path: string): ModelConfig | undefined {
  return MODELS.find((m) => m.path === path);
}
