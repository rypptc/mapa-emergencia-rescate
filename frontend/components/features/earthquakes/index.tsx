"use client";

import { useEffect, useMemo, useState } from "react";
import { useEarthquakes } from "@/hooks/emergency";
import { EarthquakeCard } from "./EarthquakeCard";

// Polleo cada 60s: coincide con la cadencia del worker (sync del feed USGS cada
// minuto) y con el TTL de caché del endpoint.
const POLL_MS = 60_000;

// Opciones del filtro de magnitud mínima (el "2+" del diseño de referencia).
const MIN_MAG_OPTIONS = [2, 3, 4, 5] as const;

/** Cuántos sismos mostrar antes del "Ver más". */
const INITIAL_VISIBLE = 8;

/**
 * Sección "Sismos recientes" para la home. Lista el catálogo USGS de Venezuela
 * (más reciente primero), con filtro de magnitud mínima y tiempos relativos que
 * se refrescan solos. Reutiliza los colores de severidad de la app.
 */
export default function EarthquakesPanel() {
  const { data: quakes, isLoading, isError } = useEarthquakes(POLL_MS);
  const [minMag, setMinMag] = useState<(typeof MIN_MAG_OPTIONS)[number]>(2);
  const [showAll, setShowAll] = useState(false);

  // Reloj para que los "hace X min" se actualicen sin recargar (cada 30s).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const filtered = useMemo(
    () => (quakes ?? []).filter((q) => (q.magnitude ?? 0) >= minMag),
    [quakes, minMag],
  );
  const visible = showAll ? filtered : filtered.slice(0, INITIAL_VISIBLE);
  const hidden = filtered.length - visible.length;

  return (
    <section
      aria-labelledby="earthquakes-heading"
      className="border-b border-[var(--eborder)] bg-[var(--ebg)] px-4 py-6"
    >
      <div className="mx-auto max-w-3xl">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2
            id="earthquakes-heading"
            className="text-sm font-bold uppercase tracking-wide text-[var(--etext2)]"
          >
            Sismos recientes · Venezuela
          </h2>
          {/* Filtro de magnitud mínima */}
          <div
            role="group"
            aria-label="Magnitud mínima"
            className="flex shrink-0 items-center gap-1 rounded-full border border-[var(--eborder)] bg-[var(--esurf)] p-0.5"
          >
            {MIN_MAG_OPTIONS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMinMag(m);
                  setShowAll(false);
                }}
                aria-pressed={minMag === m}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
                  minMag === m
                    ? "bg-[var(--etext)] text-white"
                    : "text-[var(--etext2)] hover:bg-[var(--ebg)]"
                }`}
              >
                {m}+
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <p className="py-6 text-center text-sm text-[var(--etext2)]">
            Cargando sismos…
          </p>
        ) : isError ? (
          <p className="py-6 text-center text-sm text-[var(--etext2)]">
            No se pudieron cargar los sismos. Reintentando…
          </p>
        ) : filtered.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--etext2)]">
            Sin sismos de magnitud {minMag}+ en el catálogo reciente.
          </p>
        ) : (
          <>
            <ul className="flex flex-col gap-2">
              {visible.map((q) => (
                <EarthquakeCard key={q.id} quake={q} now={now} />
              ))}
            </ul>
            {hidden > 0 && (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="mt-3 w-full rounded-lg border border-[var(--eborder)] bg-[var(--esurf)] py-2 text-sm font-semibold text-[var(--etext2)] transition hover:bg-[var(--esurf)]/80"
              >
                Ver más ({hidden})
              </button>
            )}
            <p className="mt-3 text-center text-[11px] text-[var(--etext3)]">
              Fuente:{" "}
              <a
                href="https://earthquake.usgs.gov/earthquakes/map/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 hover:text-[var(--etext2)]"
              >
                USGS
              </a>{" "}
              · se actualiza cada minuto
            </p>
          </>
        )}
      </div>
    </section>
  );
}
