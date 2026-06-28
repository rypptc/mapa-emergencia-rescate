"use client";

import { useMissingStats } from "./useMissingStats";

/**
 * Tarjeta de stats en vivo del hero (mockup "ALERTA ACTIVA"): personas buscadas
 * y localizadas. Conteos del store compartido useMissingStats (un solo poll para
 * toda la página, ver ese módulo). No expone datos nuevos. ponytail.
 */
export default function HeroStats() {
  const stats = useMissingStats();
  const missing = stats?.active ?? null;
  const found = stats?.found ?? null;

  const fmt = (n: number | null) =>
    n === null ? "—" : n.toLocaleString("es-VE");

  return (
    <div className="mt-5 w-full max-w-md rounded-2xl border border-white/15 bg-white/10 px-5 py-4 text-white shadow-lg backdrop-blur-md">
      <p className="flex items-center justify-center gap-2 text-[11px] font-bold uppercase tracking-wide text-red-200">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
        Alerta activa
      </p>
      <dl className="mt-3 grid grid-cols-2 divide-x divide-white/15">
        <div className="px-2">
          <dd className="text-2xl font-bold tabular-nums sm:text-3xl">
            {fmt(missing)}
          </dd>
          <dt className="text-xs text-slate-300">buscados</dt>
        </div>
        <div className="px-2">
          <dd className="text-2xl font-bold tabular-nums text-emerald-300 sm:text-3xl">
            {fmt(found)}
          </dd>
          <dt className="text-xs text-slate-300">localizados</dt>
        </div>
      </dl>
    </div>
  );
}
