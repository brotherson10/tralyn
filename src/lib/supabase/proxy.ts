import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database";
import { readSupabasePublicEnv } from "./env";

export interface SessionUpdate {
  response: NextResponse;
  /** Auth user id from the verified JWT claims, or null when signed out. */
  userId: string | null;
  configured: boolean;
}

/**
 * Refreshes the Supabase session cookie before the route renders.
 *
 * This is an optimistic check only: it tells us whether a valid session
 * exists. Authorization (role, active flag) is enforced on the server close
 * to the data and, ultimately, by RLS in PostgreSQL.
 */
export async function updateSession(request: NextRequest): Promise<SessionUpdate> {
  const config = readSupabasePublicEnv();
  if (!config.ok) {
    return { response: NextResponse.next({ request }), userId: null, configured: false };
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(config.env.url, config.env.key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // Responses that set auth cookies must never be cached by a CDN.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // Do not run code between createServerClient and getClaims(): the refresh
  // must complete before the response is produced.
  const { data, error } = await supabase.auth.getClaims();
  const userId = !error && typeof data?.claims?.sub === "string" ? data.claims.sub : null;

  return { response, userId, configured: true };
}
