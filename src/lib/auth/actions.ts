"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import { createClient } from "@/lib/supabase/server";
import { LOGIN_MESSAGES, loginErrorMessage, loginSchema, type LoginFieldErrors, type LoginState } from "./login";
import { evaluateProfile } from "./profile";
import { HOME_PATH, LOGIN_PATH, safeNextPath } from "./routing";
import { endSession } from "./sign-out";

/**
 * Email/password sign-in. The password only travels to Supabase Auth; it is
 * never logged, returned or stored by the application. Session tokens are
 * written as HTTP cookies by @supabase/ssr (no localStorage).
 */
export async function signInAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const rawEmail = String(formData.get("email") ?? "");
  const parsed = loginSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });

  if (!parsed.success) {
    const fieldErrors: LoginFieldErrors = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === "email" || field === "password") && !fieldErrors[field]) fieldErrors[field] = issue.message;
    }
    return { status: "error", message: "Verifique os campos assinalados.", email: rawEmail.trim(), fieldErrors };
  }

  const { email, password } = parsed.data;
  if (!isSupabaseConfigured()) return { status: "error", message: LOGIN_MESSAGES.notConfigured, email };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    if (error && error.code !== "invalid_credentials") {
      console.warn("[auth] sign-in failed", { code: error.code, status: error.status });
    }
    return { status: "error", message: loginErrorMessage(error), email };
  }

  // Credentials are valid; now the application-level rules (profile/active/role).
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, name, role, active")
    .eq("id", data.user.id)
    .maybeSingle();

  const check = profileError ? null : evaluateProfile(data.user.id, data.user.email ?? null, profile);
  if (!check?.ok) {
    await endSession();
    if (profileError) console.error("[auth] profile lookup failed after sign-in", { code: profileError.code });
    const message = !check
      ? LOGIN_MESSAGES.unavailable
      : check.reason === "inactive"
        ? LOGIN_MESSAGES.inactive
        : LOGIN_MESSAGES.invalidProfile;
    return { status: "error", message, email };
  }

  revalidatePath("/", "layout");
  redirect(safeNextPath(formData.get("next")) ?? HOME_PATH);
}

export async function signOutAction(): Promise<void> {
  await endSession();
  // Drop any cached protected UI so "back" cannot show it from the router cache.
  revalidatePath("/", "layout");
  redirect(`${LOGIN_PATH}?motivo=sessao-terminada`);
}
