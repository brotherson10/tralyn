import { NextResponse } from "next/server";
import { readSupabasePublicEnv } from "@/lib/supabase/env";

/**
 * "reachable" means the Auth service answered. It does NOT prove the key is
 * valid: the local stack accepts any key on this endpoint. The hosted gateway
 * rejects invalid keys (401), reported as "rejected_key". Full proof of the
 * key is a successful sign-in.
 */
type AuthCheck = "reachable" | "not_configured" | "rejected_key" | "unreachable";

/**
 * Diagnostic endpoint: reports whether the Supabase config is present and
 * whether the Auth service is reachable with it. Never returns URLs, keys or errors
 * from upstream.
 */
export async function GET() {
  const config = readSupabasePublicEnv();
  if (!config.ok) {
    return NextResponse.json(
      { status: "degraded", supabase: { configured: false, auth: "not_configured" satisfies AuthCheck } },
      { status: 503 },
    );
  }

  let auth: AuthCheck;
  try {
    const res = await fetch(`${config.env.url}/auth/v1/health`, {
      headers: { apikey: config.env.key },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    auth = res.ok ? "reachable" : res.status === 401 || res.status === 403 ? "rejected_key" : "unreachable";
  } catch {
    auth = "unreachable";
  }

  const healthy = auth === "reachable";
  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", supabase: { configured: true, auth } },
    { status: healthy ? 200 : 503 },
  );
}
