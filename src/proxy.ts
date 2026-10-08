import { NextResponse, type NextRequest } from "next/server";
import { decideRoute } from "@/lib/auth/routing";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Optimistic route protection: refreshes the session cookie and redirects
 * based on whether a valid JWT is present. It does NOT check roles or the
 * active flag (no database access here); pages and actions do that through
 * the Data Access Layer, and PostgreSQL enforces RLS on every query.
 */
export async function proxy(request: NextRequest) {
  const { response, userId } = await updateSession(request);
  const decision = decideRoute({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    authenticated: userId !== null,
  });

  if (decision.action === "allow") return response;

  const outcome =
    decision.action === "redirect"
      ? NextResponse.redirect(new URL(decision.location, request.url))
      : NextResponse.json({ error: "Não autenticado." }, { status: 401 });

  // Keep refreshed/cleared auth cookies and their no-cache headers.
  for (const cookie of response.cookies.getAll()) outcome.cookies.set(cookie);
  for (const header of ["cache-control", "expires", "pragma"]) {
    const value = response.headers.get(header);
    if (value) outcome.headers.set(header, value);
  }
  return outcome;
}

export const config = {
  matcher: [
    // Everything except static assets and image optimization files.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
