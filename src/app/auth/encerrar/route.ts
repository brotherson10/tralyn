import { redirect } from "next/navigation";
import { getAuthState } from "@/lib/auth/session";
import { DENIAL_NOTICE } from "@/lib/auth/profile";
import { HOME_PATH, LOGIN_PATH } from "@/lib/auth/routing";
import { endSession } from "@/lib/auth/sign-out";

/**
 * Forced sign-out for authenticated users who may not use the application
 * (inactive account, missing or invalid profile). Server Components cannot
 * clear cookies, so the Data Access Layer redirects here.
 *
 * The reason is recomputed on the server; the ?motivo= query value is ignored,
 * so this endpoint can never sign out a user who is allowed in.
 */
export async function GET() {
  const state = await getAuthState();

  if (state.status === "active") redirect(HOME_PATH);

  await endSession();
  redirect(state.status === "denied" ? `${LOGIN_PATH}?motivo=${DENIAL_NOTICE[state.reason]}` : LOGIN_PATH);
}
