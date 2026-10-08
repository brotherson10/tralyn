import "server-only";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

const AUTH_COOKIE = /^sb-.+-auth-token/;

/**
 * Ends the current session on this device: revokes it in Supabase Auth
 * (scope "local", other devices stay signed in) and removes every Supabase
 * auth cookie, even if the revoke call failed. Only usable where cookies can
 * be written (Server Actions, Route Handlers).
 */
export async function endSession(): Promise<void> {
  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) console.warn("[auth] sign-out revoke failed", { code: error.code, status: error.status });
  } catch {
    console.warn("[auth] sign-out revoke failed");
  }

  const cookieStore = await cookies();
  for (const cookie of cookieStore.getAll()) {
    if (AUTH_COOKIE.test(cookie.name)) cookieStore.delete(cookie.name);
  }
}
