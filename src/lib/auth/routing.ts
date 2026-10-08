/**
 * Route access decisions used by the proxy (optimistic check based on the
 * session cookie). Authoritative checks happen again in the Data Access Layer
 * and in PostgreSQL (RLS).
 */

export const LOGIN_PATH = "/login";
export const HOME_PATH = "/dashboard";

/** Routes reachable without a session. Everything else is protected (deny by default). */
const PUBLIC_PATHS = new Set([LOGIN_PATH, "/api/health"]);
const PUBLIC_PREFIXES = ["/auth/"];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Accepts only same-origin relative paths for post-login redirects.
 * Rejects absolute URLs, protocol-relative URLs (//evil.com), backslash
 * tricks (/\evil.com), control characters and the login page itself.
 */
export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return null;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value, "http://internal.invalid");
    if (url.origin !== "http://internal.invalid") return null;
    if (url.pathname === LOGIN_PATH || isPublicPath(url.pathname)) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export type RouteDecision =
  | { action: "allow" }
  | { action: "redirect"; location: string }
  | { action: "unauthorized" };

export function decideRoute(input: { pathname: string; search: string; authenticated: boolean }): RouteDecision {
  const { pathname, search, authenticated } = input;

  if (pathname === LOGIN_PATH) {
    return authenticated ? { action: "redirect", location: HOME_PATH } : { action: "allow" };
  }
  if (isPublicPath(pathname) || authenticated) return { action: "allow" };

  if (pathname.startsWith("/api/")) return { action: "unauthorized" };

  const next = safeNextPath(`${pathname}${search}`);
  const location = next && next !== "/" ? `${LOGIN_PATH}?next=${encodeURIComponent(next)}` : LOGIN_PATH;
  return { action: "redirect", location };
}
