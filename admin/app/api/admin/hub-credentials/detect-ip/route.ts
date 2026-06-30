/**
 * BFF /api/admin/hub-credentials/detect-ip — eco de la IP del solicitante, proxy
 * a /api/public/hub-credentials/detect-ip. Útil para prellenar el form con la IP
 * del consumidor. Gateado por mirror:manage (super admin).
 */
import type { NextResponse } from "next/server";
import { createAuthedEmergencyClient } from "../../../../../src/shared/http/authed-fetch";
import { json, mapApiError, unauthorized } from "../../../_shared/proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const client = createAuthedEmergencyClient(request);
  if (!client) return unauthorized();

  const result = await client.post<{ ip: string }>(
    "/api/public/hub-credentials/detect-ip",
    {},
  );
  if (!result.ok) return mapApiError(result.error);
  return json(result.value, 200);
}
