/**
 * BFF route: GET /api/models/[path]
 *
 * Composition root genérico para los 7 modelos read-only. Valida el path contra
 * el model-registry, exige sesión (Bearer desde la cookie httpOnly) y devuelve
 * las filas. La autorización REAL la hace el backend (requireCapability
 * <model>:read); aquí un 403 del backend se propaga como 403.
 *
 * - 200 ModelRow[]  — ok
 * - 401             — sin sesión
 * - 403             — sesión sin la capacidad <model>:read
 * - 404             — path desconocido
 * - 502             — backend inalcanzable
 */
import { NextResponse } from "next/server";
import { createAuthedEmergencyClient } from "../../../../src/shared/http/authed-fetch";
import { getModel } from "../../../../src/contexts/models/model-registry";
import { createHttpModelsGateway } from "../../../../src/contexts/models/infrastructure/http-models-gateway";
import { listModel } from "../../../../src/contexts/models/application/list-model";
import { BFF_CACHE_HEADERS } from "../../_shared/bff-cache";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path: string }> },
): Promise<NextResponse> {
  const { path } = await ctx.params;

  if (!getModel(path)) {
    return NextResponse.json({ error: "Not found" }, { status: 404, headers: BFF_CACHE_HEADERS });
  }

  const client = createAuthedEmergencyClient(request);
  if (!client) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: BFF_CACHE_HEADERS });
  }

  const result = await listModel(createHttpModelsGateway(client), path);
  if (result.ok) {
    return NextResponse.json(result.value, { status: 200, headers: BFF_CACHE_HEADERS });
  }

  const { kind, status } = result.error;
  if (kind === "auth") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: BFF_CACHE_HEADERS });
  }
  if (kind === "http" && status === 403) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: BFF_CACHE_HEADERS });
  }
  return NextResponse.json(
    { error: "Upstream service error" },
    { status: 502, headers: BFF_CACHE_HEADERS },
  );
}
