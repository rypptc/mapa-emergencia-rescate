"use client";

import { memo } from "react";
import type { Earthquake } from "@/lib/types";
import { timeAgo } from "@/lib/format";
import { magnitudeSeverity, severityMeta } from "@/lib/severity";

export interface EarthquakeCardProps {
  quake: Earthquake;
  now: number;
}

/** Hora local corta de Venezuela ("7:00 a. m."). */
function localTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("es-VE", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Fila de sismo: barra de acento + lugar + tiempo a la izquierda; magnitud
 * grande coloreada por severidad a la derecha (mismo lenguaje visual que la
 * capa de edificios, vía severityMeta). Presentacional y memoizado.
 */
function EarthquakeCardImpl({ quake, now }: EarthquakeCardProps) {
  const sev = severityMeta(magnitudeSeverity(quake.magnitude));
  const mag = quake.magnitude === null ? "—" : quake.magnitude.toFixed(1);

  return (
    <li
      className="relative flex items-stretch gap-3 overflow-hidden rounded-xl border border-[var(--eborder)] bg-[var(--esurf)] pr-3"
      style={{ borderLeftColor: sev.color, borderLeftWidth: 4 }}
    >
      <div className="min-w-0 flex-1 py-2.5 pl-3">
        <p className="truncate text-sm font-semibold text-[var(--etext)]">
          {sev.emoji} {quake.place}
        </p>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-[var(--etext2)]">
          <span
            title={new Date(quake.occurredAt).toLocaleString("es-VE")}
          >
            {timeAgo(quake.occurredAt, now)}
          </span>
          <span aria-hidden className="text-[var(--etext3)]">
            ·
          </span>
          <span>{localTime(quake.occurredAt)}</span>
          {quake.depthKm !== null && (
            <>
              <span aria-hidden className="text-[var(--etext3)]">
                ·
              </span>
              <span>{Math.round(quake.depthKm)} km prof.</span>
            </>
          )}
          {quake.tsunami && (
            <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700">
              Tsunami
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center">
        <span
          className="text-2xl font-extrabold tabular-nums"
          style={{ color: sev.text }}
          aria-label={`Magnitud ${mag}`}
        >
          {mag}
        </span>
      </div>
    </li>
  );
}

export const EarthquakeCard = memo(EarthquakeCardImpl);
