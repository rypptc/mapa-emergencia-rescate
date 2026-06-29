ALTER TABLE "hospital_patients" ADD COLUMN "document_hash" text;--> statement-breakpoint
ALTER TABLE "patient_import_rows" ADD COLUMN "document_hash" text;--> statement-breakpoint
-- CREATE INDEX (no CONCURRENTLY): el migrador de Drizzle (node-postgres) corre
-- TODAS las sentencias dentro de una transacción y `CONCURRENTLY` es ilegal en un
-- bloque transaccional (rompería migrate). Aquí es seguro igual: `document_hash`
-- se agrega en ESTA misma migración (todas las filas existentes quedan NULL), así
-- que el índice PARCIAL `WHERE document_hash IS NOT NULL` indexa CERO filas y su
-- construcción es instantánea sin bloquear escrituras. (worker/migrate.ts además
-- aplica lock_timeout como guarda anti-outage.)
CREATE INDEX "idx_hospital_patients_document_hash" ON "hospital_patients" USING btree ("hospital_id","document_hash") WHERE document_hash IS NOT NULL;
