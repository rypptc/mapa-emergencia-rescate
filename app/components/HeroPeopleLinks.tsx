"use client";

import { useMissingStats } from "./useMissingStats";

/**
 * Botones del hero para "Personas desaparecidas" y "Localizados a salvo" con el
 * total en vivo embebido. Conteos del store compartido useMissingStats (un solo
 * poll para toda la página).
 */
export default function HeroPeopleLinks() {
  const stats = useMissingStats();
  const missing = stats?.active ?? null;
  const found = stats?.found ?? null;

  return (
    <>
      <a
        href="#e-directory"
        className="flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50"
      >
        🧍 Personas desaparecidas
        {missing !== null && (
          <span className="inline-flex items-center rounded-full bg-purple-100 px-2 py-0.5 text-xs font-bold text-purple-800">
            {missing.toLocaleString("es-VE")}
          </span>
        )}
      </a>
      <a
        href="#e-directory"
        className="flex items-center justify-center gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-5 py-2.5 text-sm font-semibold text-emerald-700 shadow-sm transition hover:bg-emerald-100"
      >
        💚 Localizadas a salvo
        {found !== null && (
          <span className="inline-flex items-center rounded-full bg-emerald-600 px-2 py-0.5 text-xs font-bold text-white">
            {found.toLocaleString("es-VE")}
          </span>
        )}
      </a>
    </>
  );
}
