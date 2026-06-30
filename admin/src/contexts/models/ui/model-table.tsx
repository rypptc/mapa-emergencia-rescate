"use client";

import { useMemo, useState } from "react";
import { Input } from "@/src/ui";
import { useModelList } from "./use-model-list";
import type { ModelConfig } from "../model-registry";
import type { ModelRow } from "../application/models-gateway";

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function matchesQuery(row: ModelRow, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return Object.values(row).some((v) => renderCell(v).toLowerCase().includes(needle));
}

/**
 * Tabla read-only genérica para un modelo. Lee columnas del model-registry,
 * lista vía /api/models/<path>, con búsqueda client-side. F1: solo lectura.
 */
export function ModelTable({ model }: { model: ModelConfig }) {
  const { data, isLoading, isError, error } = useModelList(model.path);
  const [query, setQuery] = useState("");

  const rows = useMemo(
    () => (data ?? []).filter((r) => matchesQuery(r, query)),
    [data, query],
  );

  if (isLoading) return <p className="mt-4 text-sm text-gray-500">Cargando {model.label}…</p>;
  if (isError) {
    return (
      <p role="alert" className="mt-4 text-sm text-red-600">
        Error al cargar {model.label}: {error instanceof Error ? error.message : "desconocido"}
      </p>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <Input
          label=""
          type="search"
          placeholder={`Buscar en ${model.label}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="max-w-xs"
        />
        <span className="text-sm text-gray-500">{rows.length} resultado(s)</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b text-left">
              {model.columns.map((c) => (
                <th key={c.key} className="px-3 py-2 font-semibold">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={model.columns.length} className="px-3 py-6 text-center text-gray-500">
                  Sin datos.
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={renderCell(row.id) + String(i)} className="border-b last:border-0">
                  {model.columns.map((c) => (
                    <td key={c.key} className="px-3 py-2 align-top">
                      {renderCell(row[c.key])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
