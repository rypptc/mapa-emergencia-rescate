"use client";

import { useQuery } from "@tanstack/react-query";
import type { ModelRow } from "../application/models-gateway";

/**
 * Hook de listado de un modelo vía el BFF same-origin (/api/models/<path>).
 *
 * El BFF ya devuelve filas limpias; aquí solo gestionamos cache/estado con
 * TanStack Query. El fetch lanza en error (contrato de React Query) — único
 * punto de throw sancionado en este contexto.
 */
async function fetchModel(path: string): Promise<ModelRow[]> {
  const res = await fetch(`/api/models/${path}`, { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`No se pudo cargar ${path} (${res.status})`);
  }
  return (await res.json()) as ModelRow[];
}

export function useModelList(path: string) {
  return useQuery({
    queryKey: ["model", path],
    queryFn: () => fetchModel(path),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
