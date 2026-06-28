-- Índices de búsqueda y upsert para missing_persons.
-- TODO ya existe en prod (creado out-of-band); estas sentencias son idempotentes
-- (IF NOT EXISTS) para que un rebuild limpio del esquema quede igual que prod.
-- El migrador aplica esto en cada deploy sin romper (audit A-2 / M-5).
-- (Antes era 0004_known_sumo; renumerado a 0006 tras el merge con main, que ya
-- traía 0004/0005. La parte GIN/extensiones es SQL crudo que drizzle-kit no
-- expresa desde el schema, así que se mantiene a mano aquí.)

-- Árbitro del ON CONFLICT (source, external_id) de upsertExternalMissingBatch.
CREATE UNIQUE INDEX IF NOT EXISTS "missing_persons_source_external_id_idx"
  ON "missing_persons" USING btree ("source","external_id")
  WHERE external_id IS NOT NULL;

-- Búsqueda acento-insensible: extensiones + función IMMUTABLE + índice GIN
-- trigram sobre la MISMA expresión que usa listMissingPage (accentSearchReady).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- f_unaccent: wrapper IMMUTABLE (unaccent es STABLE; un índice de expresión
-- requiere IMMUTABLE). Fija el search_path para que sea reproducible.
CREATE OR REPLACE FUNCTION f_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  AS $$ SELECT public.unaccent('public.unaccent', $1) $$;

CREATE INDEX IF NOT EXISTS "idx_missing_search"
  ON "missing_persons" USING gin (
    f_unaccent(name || ' ' || last_seen || ' ' || coalesce(description, ''))
    gin_trgm_ops
  );
