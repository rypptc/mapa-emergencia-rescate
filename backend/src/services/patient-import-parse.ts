/**
 * Parseo PURO de payloads de importación de pacientes (#151, Fase 4) — sin DB.
 *
 * Convierte un lote subido como CSV o XLSX ESTRUCTURADO en `RawPatientRow[]`, la
 * MISMA forma que ya consume el pipeline JSON (staging → worker normaliza/valida/
 * deduplica/aplica). No reemplaza ese pipeline: solo materializa las filas crudas
 * ANTES de que el worker las normalice, así CSV/XLSX reutilizan todo lo existente
 * (idempotencia, dedup, purga C5 del crudo) sin tocar el esquema ni el worker.
 *
 * NO es OCR ni inferencia: exige un archivo TABULAR con cabecera. La primera fila
 * son los encabezados; cada columna se mapea a un campo de `RawPatientRow` por un
 * alias conservador (ES/EN). Las columnas no reconocidas se conservan bajo su
 * encabezado crudo (igual que el passthrough del JSON) para no perder dato.
 *
 * Seguridad: este parse corre en el request path, así que es ACOTADO y de tiempo
 * lineal — sin OCR, sin trabajo pesado. El trabajo pesado real (resolución de
 * hospital, dedup contra la DB, apply) sigue en el worker. El XLSX se lee con
 * `zlib` nativo (sin dependencia nueva) con cotas explícitas de descompresión
 * para evitar zip-bombs. Un archivo ilegible/ inválido falla el LOTE entero con
 * un mensaje claro (`ImportParseError` → 400); los problemas de FILA siguen
 * resolviéndose por-fila más adelante en el worker, sin cambios.
 */

import { inflateRawSync } from "zlib";

import type { RawPatientRow } from "@/services/patient-import-logic";

/** Tope de filas por lote (espeja el `.max(2000)` del route para JSON). */
export const MAX_IMPORT_ROWS = 2000;

/** Cota dura del payload decodificado (bytes) antes de parsear. */
const MAX_DECODED_BYTES = 6 * 1024 * 1024;

/** Cotas anti zip-bomb del lector XLSX. */
const XLSX_MAX_ENTRIES = 256;
const XLSX_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
const XLSX_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

/**
 * Cota de columnas del lector XLSX: límite REAL de Excel (XFD = 16384 columnas).
 * Una referencia de celda como `ZZZZZ1` decodifica a un índice de columna enorme;
 * sin esta cota, `cells[col] = value` crea un array disperso gigante y el relleno
 * posterior de huecos lo materializa entero (DoS por memoria) ANTES de cualquier
 * tope por bytes/filas. Se valida ANTES de escribir la celda.
 */
const XLSX_MAX_COLS = 16384;

/**
 * Cota de filas del lector XLSX: cabecera + filas de datos. Espeja `MAX_IMPORT_ROWS`
 * con una fila extra para la cabecera. Se valida MIENTRAS se parsea (no después de
 * materializar toda la grilla), para acotar el trabajo en el request path.
 */
const XLSX_MAX_ROWS = MAX_IMPORT_ROWS + 1;

/**
 * Cota del ÁREA total materializada (filas × ancho). Las cotas de columna y de
 * fila por separado no bastan: un input chico puede declarar muchas filas, cada
 * una con UNA celda en una columna alta pero válida (p.ej. XFD = índice 16383).
 * Cada fila densifica `cells.length` hasta esa columna al rellenar huecos, así
 * que `XLSX_MAX_ROWS × XLSX_MAX_COLS` slots se materializan desde pocos bytes
 * (amplificación DoS por memoria en el request path). Esta cota acota la suma de
 * `cells.length` sobre todas las filas y falla el LOTE antes de esa explosión.
 */
const XLSX_MAX_CELLS = 200_000;

/** Content-types soportados para creación de lotes. */
export const CONTENT_TYPE = {
  JSON: "application/json",
  CSV: "text/csv",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

export type SupportedContentType = (typeof CONTENT_TYPE)[keyof typeof CONTENT_TYPE];

/** Content-types que se cargan como archivo (`fileBase64`), no como `rows` JSON. */
export const FILE_CONTENT_TYPES: ReadonlySet<string> = new Set([CONTENT_TYPE.CSV, CONTENT_TYPE.XLSX]);

/**
 * Tipos de contenido que requerirían OCR/ICR (imagen o PDF) para extraer datos.
 * NO se procesan en esta fase: no hay motor de OCR configurado y el
 * reconocimiento de manuscrito SIEMPRE exige revisión humana (#151/#158). Se
 * reconocen explícitamente para responder un 501 claro en el route, en vez de
 * un 400 genérico de "contentType no soportado".
 */
export function isOcrPendingContentType(contentType: string): boolean {
  const ct = contentType.trim().toLowerCase();
  return ct === "application/pdf" || ct.startsWith("image/");
}

/**
 * Error de parseo a NIVEL DE LOTE (archivo ilegible, vacío, demasiado grande o
 * con cabecera no mapeable). El route lo traduce a 400 con un mensaje claro. No
 * lleva PII ni stack del archivo.
 */
export class ImportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportParseError";
  }
}

/**
 * Alias de cabecera (clave normalizada → campo de `RawPatientRow`). Conservador y
 * explícito: ES/EN comunes. Lo no listado se conserva bajo su encabezado crudo.
 * Documentado y verificado en `test/patient-import-parse.test.ts`.
 */
const HEADER_ALIASES: Readonly<Record<string, keyof RawPatientRow>> = Object.freeze({
  hospital: "hospital",
  hospitalname: "hospital",
  nombrehospital: "hospital",
  hospitalid: "hospitalId",
  idhospital: "hospitalId",
  name: "name",
  nombre: "name",
  paciente: "name",
  age: "age",
  edad: "age",
  condition: "condition",
  condicion: "condition",
  estadoclinico: "condition",
  status: "status",
  estado: "status",
  documentid: "documentId",
  document: "documentId",
  documento: "documentId",
  cedula: "documentId",
  dni: "documentId",
  ci: "documentId",
  notes: "notes",
  notas: "notes",
  observaciones: "notes",
  contact: "contact",
  contacto: "contact",
  telefono: "contact",
});

/** Quita acentos comunes del español (misma tabla translate que el dedup). */
function stripAccents(s: string): string {
  const from = "áéíóúüñÁÉÍÓÚÜÑ";
  const to = "aeiouunAEIOUUN";
  let out = "";
  for (const ch of s) {
    const i = from.indexOf(ch);
    out += i === -1 ? ch : to[i];
  }
  return out;
}

/**
 * Clave normalizada de un encabezado: minúsculas, sin acentos, solo alfanumérico
 * (se descartan espacios/guiones/underscores). "Hospital ID" / "hospital_id" /
 * "ID Hospital" colapsan para mapear al mismo alias.
 */
function headerKey(raw: string): string {
  return stripAccents(raw.toLowerCase()).replace(/[^a-z0-9]/g, "");
}

/** Decodifica las entidades XML básicas (las que produce un XLSX). */
function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return m;
    }
  });
}

// --------------------------------------------------------------------------
// CSV / delimitados (RFC4180-ish): comillas dobles con escape "", saltos de
// línea y delimitadores embebidos dentro de comillas. Tiempo lineal, sin regex
// con backtracking. Detecta el delimitador (`,` `;` `\t`) por la primera línea.
// --------------------------------------------------------------------------

function sniffDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]!++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d]! > counts[best]!) best = d;
  return best;
}

export function parseDelimited(input: string): string[][] {
  // Normaliza saltos de línea y descarta el BOM UTF-8.
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const delimiter = sniffDelimiter(text);
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  // Última fila sin salto final.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// --------------------------------------------------------------------------
// XLSX mínimo (sin dependencia): un .xlsx es un ZIP de XML. Leemos el directorio
// central, inflamos con `zlib` (cotas anti zip-bomb) la hoja y la tabla de
// strings compartidos, y extraemos las celdas. Solo lo necesario para un libro
// tabular con cabecera; no fórmulas, formato ni múltiples hojas seleccionadas.
// --------------------------------------------------------------------------

interface ZipEntry {
  method: number;
  localOffset: number;
  compSize: number;
  uncompSize: number;
}

function readZipCentralDirectory(buf: Buffer): Map<string, ZipEntry> {
  // Localiza el End Of Central Directory (firma 0x06054b50) escaneando desde el
  // final (el comentario del zip, si existe, va después; cota de búsqueda 64KB).
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 0x10000 - 22);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new ImportParseError("El archivo no es un XLSX válido (falta el índice ZIP).");

  const total = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOffset === 0xffffffff) {
    throw new ImportParseError("XLSX demasiado grande o en formato ZIP64 no soportado.");
  }
  if (total > XLSX_MAX_ENTRIES) {
    throw new ImportParseError("El XLSX tiene demasiadas entradas internas.");
  }

  const entries = new Map<string, ZipEntry>();
  const CEN_SIG = 0x02014b50;
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) {
      throw new ImportParseError("El archivo no es un XLSX válido (índice ZIP corrupto).");
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, localOffset, compSize, uncompSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf: Buffer, entry: ZipEntry, budget: { used: number }): string {
  if (entry.uncompSize > XLSX_MAX_ENTRY_BYTES) {
    throw new ImportParseError("Una entrada del XLSX excede el tamaño permitido.");
  }
  // Cabecera local: los campos name/extra pueden diferir del directorio central.
  const LOC_SIG = 0x04034b50;
  const off = entry.localOffset;
  if (off + 30 > buf.length || buf.readUInt32LE(off) !== LOC_SIG) {
    throw new ImportParseError("El archivo no es un XLSX válido (cabecera local corrupta).");
  }
  const nameLen = buf.readUInt16LE(off + 26);
  const extraLen = buf.readUInt16LE(off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  const data = buf.subarray(dataStart, dataStart + entry.compSize);

  let out: Buffer;
  if (entry.method === 0) {
    out = Buffer.from(data);
  } else if (entry.method === 8) {
    out = inflateRawSync(data, { maxOutputLength: XLSX_MAX_ENTRY_BYTES });
  } else {
    throw new ImportParseError("Compresión interna del XLSX no soportada.");
  }
  budget.used += out.length;
  if (budget.used > XLSX_MAX_TOTAL_BYTES) {
    throw new ImportParseError("El XLSX descomprimido excede el tamaño permitido.");
  }
  return out.toString("utf8");
}

/** Tabla de strings compartidos: cada `<si>` → texto concatenado de sus `<t>`. */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1]!;
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t: RegExpExecArray | null;
    let text = "";
    while ((t = tRe.exec(inner)) !== null) text += t[1]!;
    out.push(decodeXmlEntities(text));
  }
  return out;
}

/** Columna de una referencia de celda ("AB12" → índice 0-based de "AB"). */
function columnIndex(ref: string): number {
  let col = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code >= 65 && code <= 90) col = col * 26 + (code - 64);
    else if (code >= 97 && code <= 122) col = col * 26 + (code - 96);
    else break;
  }
  return col - 1;
}

function parseSheet(xml: string, shared: string[]): string[][] {
  const grid: string[][] = [];
  let totalCells = 0;
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowXml = rm[1]!;
    const cells: string[] = [];
    let autoCol = 0;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(rowXml)) !== null) {
      const attrs = cm[1] ?? "";
      const body = cm[2] ?? "";
      const refMatch = /\br="([A-Za-z]+)\d+"/.exec(attrs);
      const col = refMatch ? columnIndex(refMatch[1]!) : autoCol;
      // Cota de columna ANTES de tocar `cells[col]`: una ref tipo `ZZZZZ1` decodifica
      // a un índice enorme y crearía un array disperso gigante (DoS por memoria).
      if (col >= XLSX_MAX_COLS) {
        throw new ImportParseError(`El XLSX excede el máximo de ${XLSX_MAX_COLS} columnas.`);
      }
      autoCol = col + 1;
      const typeMatch = /\bt="([^"]+)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : undefined;

      let value: string;
      if (type === "inlineStr") {
        const is = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
        value = is ? decodeXmlEntities(is[1]!) : "";
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const raw = v ? v[1]! : "";
        if (type === "s") {
          const idx = Number(raw);
          value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? shared[idx]! : "";
        } else {
          value = decodeXmlEntities(raw);
        }
      }
      if (col >= 0) cells[col] = value;
    }
    // Rellena huecos (celdas vacías omitidas en el XML) con cadena vacía.
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = "";
    grid.push(cells);
    // Cota de filas MIENTRAS se parsea (no después de materializar toda la grilla).
    if (grid.length > XLSX_MAX_ROWS) {
      throw new ImportParseError(`El archivo excede el máximo de ${MAX_IMPORT_ROWS} filas.`);
    }
    // Cota del ÁREA total: acumula el ancho densificado de cada fila. Pocas filas
    // con una celda en columna alta (válida) pueden materializar millones de slots;
    // cortamos a NIVEL DE LOTE antes de esa amplificación de memoria.
    totalCells += cells.length;
    if (totalCells > XLSX_MAX_CELLS) {
      throw new ImportParseError("El XLSX excede el máximo de celdas permitidas.");
    }
  }
  return grid;
}

export function parseXlsxBuffer(buf: Buffer): string[][] {
  try {
    const entries = readZipCentralDirectory(buf);
    const budget = { used: 0 };

    // Elige la primera hoja (sheet1) determinísticamente entre xl/worksheets/*.xml.
    const sheetNames = [...entries.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort();
    const sheetName = sheetNames[0];
    if (!sheetName) throw new ImportParseError("El XLSX no contiene ninguna hoja.");

    let shared: string[] = [];
    const ssEntry = entries.get("xl/sharedStrings.xml");
    if (ssEntry) shared = parseSharedStrings(inflateEntry(buf, ssEntry, budget));

    const sheetXml = inflateEntry(buf, entries.get(sheetName)!, budget);
    return parseSheet(sheetXml, shared);
  } catch (err) {
    // `ImportParseError` ya lleva un mensaje seguro por-lote: lo dejamos pasar.
    // Cualquier OTRO error (zlib en deflate corrupto, RangeError por zip truncado
    // con offsets fuera de rango, etc.) se remapea a `ImportParseError` con un
    // mensaje genérico — nunca exponemos contenido del archivo ni el stack, y el
    // route lo traduce a 400 en vez de 500.
    if (err instanceof ImportParseError) throw err;
    throw new ImportParseError("El archivo no es un XLSX válido o está corrupto.");
  }
}

// --------------------------------------------------------------------------
// Tabla (cabecera + filas) → RawPatientRow[]
// --------------------------------------------------------------------------

/** ¿La celda tiene contenido tras recortar? */
function nonEmpty(s: string | undefined): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

/**
 * Mapea una grilla (primera fila = cabecera) a `RawPatientRow[]`. Columnas con
 * alias conocido se asignan al campo canónico; las demás se conservan bajo su
 * encabezado crudo (passthrough, como el JSON). Filas totalmente vacías se omiten.
 */
export function tableToRows(grid: string[][]): RawPatientRow[] {
  // Primera fila NO vacía = cabecera.
  const headerRowIndex = grid.findIndex((r) => r.some(nonEmpty));
  if (headerRowIndex === -1) {
    throw new ImportParseError("El archivo no tiene encabezados.");
  }
  const header = grid[headerRowIndex]!.map((h) => (h ?? "").trim());
  const fields = header.map((h) => (h ? HEADER_ALIASES[headerKey(h)] ?? h : null));
  if (fields.every((f) => f === null)) {
    throw new ImportParseError("El archivo no tiene encabezados.");
  }

  const rows: RawPatientRow[] = [];
  for (let r = headerRowIndex + 1; r < grid.length; r++) {
    const cells = grid[r]!;
    if (!cells.some(nonEmpty)) continue; // fila vacía → se omite
    const obj: RawPatientRow = {};
    for (let c = 0; c < fields.length; c++) {
      const field = fields[c];
      if (field === null) continue;
      const value = (cells[c] ?? "").trim();
      if (value === "") continue;
      (obj as Record<string, unknown>)[field as string] = value;
    }
    rows.push(obj);
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new ImportParseError(`El archivo excede el máximo de ${MAX_IMPORT_ROWS} filas.`);
    }
  }
  if (rows.length === 0) {
    throw new ImportParseError("El archivo no contiene filas de datos.");
  }
  return rows;
}

// --------------------------------------------------------------------------
// Entrada pública: decodifica el base64 y despacha por content-type.
// --------------------------------------------------------------------------

function decodeBase64(fileBase64: string): Buffer {
  const cleaned = fileBase64.trim();
  if (!cleaned) throw new ImportParseError("Falta el contenido del archivo (fileBase64 vacío).");
  // Validación estricta de base64 (evita que datos basura pasen como bytes).
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    throw new ImportParseError("fileBase64 no es base64 válido.");
  }
  const buf = Buffer.from(cleaned, "base64");
  if (buf.length === 0) throw new ImportParseError("El archivo está vacío.");
  if (buf.length > MAX_DECODED_BYTES) {
    throw new ImportParseError("El archivo excede el tamaño máximo permitido.");
  }
  return buf;
}

/**
 * Convierte un payload de archivo (CSV/XLSX) en `RawPatientRow[]`. Lanza
 * `ImportParseError` (→ 400) si el archivo es ilegible, está vacío o no tiene una
 * cabecera mapeable. El JSON estructurado NO pasa por aquí: el route usa `rows`
 * directo (no regresión).
 */
export function parseImportFile(contentType: string, fileBase64: string): RawPatientRow[] {
  const buf = decodeBase64(fileBase64);
  if (contentType === CONTENT_TYPE.CSV) {
    return tableToRows(parseDelimited(buf.toString("utf8")));
  }
  if (contentType === CONTENT_TYPE.XLSX) {
    return tableToRows(parseXlsxBuffer(buf));
  }
  throw new ImportParseError(`Content-type no soportado para archivo: ${contentType}`);
}
