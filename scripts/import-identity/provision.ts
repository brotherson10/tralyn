import { randomBytes } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import {
  BAN_DURATION,
  IMPORT_IDENTITY,
  identityProblems,
  type AuthUserState,
  type IdentitySnapshot,
} from "./identity";

/**
 * Idempotent provisioning of the technical import identity, using only the
 * supported Supabase Auth Admin API (no direct writes to auth.users).
 *
 *   absent              → create (no password, confirmed, banned) → trigger creates
 *                         the profile → verify → set active=false → verify
 *   present & conforming → no change ("already_present")
 *   present & divergent  → abort, nothing is corrected
 */

export type AdminClient = SupabaseClient<Database>;

export class ProvisionAbortedError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(`${message}: ${problems.join("; ")}`);
    this.name = "ProvisionAbortedError";
  }
}

export interface ProvisionResult {
  outcome: "created" | "already_present";
  userId: string;
}

export interface ProvisionOptions {
  now?: () => Date;
  /** Re-reads after a concurrent creation (e-mail already exists). */
  retry?: { attempts: number; delayMs: number };
}

function toUserState(user: User): AuthUserState {
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    bannedUntil: user.banned_until ?? null,
    lastSignInAt: user.last_sign_in_at ?? null,
    deletedAt: user.deleted_at ?? null,
    isAnonymous: user.is_anonymous ?? false,
    appMetadata: (user.app_metadata ?? {}) as Record<string, unknown>,
  };
}

/** Reads the identity state through the Admin API (paginated) and the profile row. */
export async function readIdentity(admin: AdminClient): Promise<IdentitySnapshot> {
  const users: AuthUserState[] = [];
  const perPage = 1000;
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw new Error(`Falha ao listar utilizadores Auth (${error.status ?? "?"} ${error.code ?? ""})`);
    for (const user of data.users) {
      if (user.email?.toLowerCase() === IMPORT_IDENTITY.email) users.push(toUserState(user));
    }
    if (data.users.length < perPage) break;
  }

  let profile: IdentitySnapshot["profile"] = null;
  if (users.length === 1) {
    const { data, error } = await admin
      .from("profiles")
      .select("id, name, role, active")
      .eq("id", users[0].id)
      .maybeSingle();
    if (error) throw new Error(`Falha ao ler o profile (${error.code})`);
    profile = data;
  }
  return { users, profile };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function provisionImportIdentity(
  admin: AdminClient,
  options: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const now = options.now ?? (() => new Date());
  const retry = options.retry ?? { attempts: 10, delayMs: 300 };

  // 1. Already there? Accept only an exactly conforming identity.
  const existing = await readIdentity(admin);
  if (existing.users.length > 0) {
    const problems = identityProblems(existing, now());
    if (problems.length > 0) throw new ProvisionAbortedError("Identidade existente diverge do estado esperado", problems);
    return { outcome: "already_present", userId: existing.users[0].id };
  }

  // 2. Create. No password is sent: the account cannot log in with one.
  const { data, error } = await admin.auth.admin.createUser({
    email: IMPORT_IDENTITY.email,
    email_confirm: true,
    ban_duration: BAN_DURATION,
    user_metadata: { name: IMPORT_IDENTITY.name },
    app_metadata: { [IMPORT_IDENTITY.marker.key]: IMPORT_IDENTITY.marker.value },
  });

  if (error || !data.user) {
    // A concurrent run may have created it first. GoTrue reports that as 422
    // (email_exists) or, when both requests pass its pre-check, as a 500 from
    // the unique e-mail index. Either way: re-read, never create a second one.
    const afterConflict = await readIdentity(admin);
    if (afterConflict.users.length === 0) {
      throw new Error(`Falha ao criar a identidade (${error?.status ?? "?"} ${error?.code ?? ""})`);
    }
    // Wait for the other run to finish; never fix the account ourselves.
    let problems: string[] = [];
    for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
      const snapshot = await readIdentity(admin);
      problems = identityProblems(snapshot, now());
      if (problems.length === 0) return { outcome: "already_present", userId: snapshot.users[0].id };
      await sleep(retry.delayMs);
    }
    throw new ProvisionAbortedError("Criação concorrente não resultou numa identidade conforme", problems);
  }

  const userId = data.user.id;

  // 3. Fresh account: everything conforming except the profile, still active.
  const fresh = await readIdentity(admin);
  const freshProblems = identityProblems(fresh, now(), true);
  if (freshProblems.length > 0) throw new ProvisionAbortedError("Identidade recém-criada inesperada", freshProblems);

  // 4. Deactivate the profile (only here, on initial creation).
  const { error: updateError } = await admin
    .from("profiles")
    .update({ active: false })
    .eq("id", userId)
    .eq("active", true)
    .select("id")
    .single();
  if (updateError) throw new Error(`Falha ao desativar o profile (${updateError.code})`);

  // 5. Final proof.
  const final = await readIdentity(admin);
  const finalProblems = identityProblems(final, now());
  if (finalProblems.length > 0) throw new ProvisionAbortedError("Estado final não conforme", finalProblems);
  return { outcome: "created", userId };
}

/**
 * Live proof that authentication is blocked: a password sign-in with a random
 * value (never printed or stored) must be refused as `user_banned` and return
 * no session. A failed sign-in does not create a session.
 */
export async function probeAuthenticationBlocked(publicClient: SupabaseClient): Promise<string | null> {
  const throwaway = randomBytes(32).toString("base64url");
  const { data, error } = await publicClient.auth.signInWithPassword({ email: IMPORT_IDENTITY.email, password: throwaway });
  if (data.session) return "uma sessão foi criada";
  if (error?.code !== "user_banned") return `resposta inesperada ao login (${error?.status ?? "?"} ${error?.code ?? "sem erro"})`;
  return null;
}
