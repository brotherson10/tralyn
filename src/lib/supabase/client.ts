import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/types/database";
import { getSupabasePublicEnv } from "./env";

/**
 * Supabase client for Client Components. Uses the public key only; every
 * query is subject to RLS as the signed-in user. Never use it for stock
 * mutations directly — those go through validated server code and the
 * database RPC.
 */
export function createClient() {
  const { url, key } = getSupabasePublicEnv();
  return createBrowserClient<Database>(url, key);
}
