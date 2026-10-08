import "server-only";

import { cache } from "react";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { hasPermission, type Permission } from "./permissions";
import { DENIAL_NOTICE, evaluateProfile, type CurrentUser, type DenialReason } from "./profile";
import { LOGIN_PATH } from "./routing";

/**
 * Data Access Layer for authentication.
 *
 * Every protected page, Server Action and Route Handler calls
 * requireActiveUser() (or requirePermission()). The proxy only performs an
 * optimistic cookie check; this is the authoritative application-level
 * check. Data access is still authorized independently by RLS.
 */

export type AuthState =
  | { status: "signed_out" }
  | { status: "active"; user: CurrentUser }
  | { status: "denied"; reason: DenialReason };

/** Resolved once per request (React cache). */
export const getAuthState = cache(async (): Promise<AuthState> => {
  if (!isSupabaseConfigured()) return { status: "signed_out" };

  const supabase = await createClient();
  // getClaims() validates the JWT (signature + expiry); the session cookie
  // alone is never trusted.
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || typeof claims.sub !== "string") return { status: "signed_out" };

  const email = typeof claims.email === "string" ? claims.email : null;

  // RLS lets every authenticated user read their own profile (even when inactive).
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, name, role, active")
    .eq("id", claims.sub)
    .maybeSingle();

  if (profileError) {
    // Fail closed without leaking details to the user.
    console.error("[auth] profile lookup failed", { code: profileError.code });
    throw new Error("Não foi possível validar a sessão.");
  }

  const check = evaluateProfile(claims.sub, email, profile);
  return check.ok ? { status: "active", user: check.user } : { status: "denied", reason: check.reason };
});

/** Returns the active user or redirects (signed out → /login, denied → forced sign-out). */
export async function requireActiveUser(): Promise<CurrentUser> {
  const state = await getAuthState();
  if (state.status === "active") return state.user;
  if (state.status === "denied") redirect(`/auth/encerrar?motivo=${DENIAL_NOTICE[state.reason]}`);
  redirect(LOGIN_PATH);
}

/** UI-level gate for pages restricted to some roles. RLS still enforces data access. */
export async function requirePermission(permission: Permission): Promise<CurrentUser> {
  const user = await requireActiveUser();
  if (!hasPermission(user.role, permission)) redirect("/sem-permissao");
  return user;
}
