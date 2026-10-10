/**
 * Integration-test helpers for the LOCAL Supabase stack (Docker).
 *
 * - Authorization is always exercised through the Data API with the public
 *   (publishable) key and a real signed-in user, so RLS is fully in effect.
 * - The direct `postgres` connection is used only for fixtures (creating auth
 *   users, setting roles the way an admin would via SQL) and to prove that
 *   ledger rules hold even for a superuser. The secret/service-role key is
 *   never used.
 */
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import type { Database } from "@/types/database";

interface LocalStack {
  apiUrl: string;
  dbUrl: string;
  publishableKey: string;
}

function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run DB tests against a non-local target: ${host}`);
  }
}

let stack: LocalStack | undefined;

export function localStack(): LocalStack {
  if (stack) return stack;
  const raw = execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  if (!status.API_URL || !status.DB_URL || !status.PUBLISHABLE_KEY) {
    throw new Error("Local Supabase is not running. Start it with `npm run db:start`.");
  }
  assertLocal(status.API_URL);
  assertLocal(status.DB_URL.replace(/^postgresql:/, "http:"));
  stack = { apiUrl: status.API_URL, dbUrl: status.DB_URL, publishableKey: status.PUBLISHABLE_KEY };
  return stack;
}

// ---------------------------------------------------------------------------
// Direct database access (fixtures / superuser checks only)
// ---------------------------------------------------------------------------
let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: localStack().dbUrl, max: 6 });
  return pool;
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export const uid = () => randomUUID().slice(0, 8).toUpperCase();

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------
export type Role = "admin" | "operator" | "viewer";

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

/** Creates an auth user (the profile is created by the auth trigger), then sets role/active. */
export async function createUser(
  role: Role,
  opts: { active?: boolean; email?: string; password?: string } = {},
): Promise<TestUser> {
  const id = randomUUID();
  const email = opts.email ?? `${role}-${id.slice(0, 8)}@test.local`;
  const password = opts.password ?? `Test-${randomUUID()}`;
  await db().query(
    `insert into auth.users (
       instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
       raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
       confirmation_token, recovery_token, email_change_token_new, email_change,
       email_change_token_current, phone_change, phone_change_token, reauthentication_token
     ) values (
       '00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
       extensions.crypt($3, extensions.gen_salt('bf')), now(),
       '{"provider":"email","providers":["email"]}', $4, now(), now(),
       '', '', '', '', '', '', '', ''
     )`,
    [id, email, password, JSON.stringify({ name: `Teste ${role}` })],
  );
  await db().query(
    `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
     values (gen_random_uuid(), $1::uuid, $2::text, $3, 'email', now(), now(), now())`,
    [id, id, JSON.stringify({ sub: id, email, email_verified: true })],
  );
  await setProfile(id, { role, active: opts.active ?? true });
  return { id, email, password };
}

export async function setProfile(id: string, fields: { role?: Role; active?: boolean }): Promise<void> {
  await db().query(
    `update public.profiles set role = coalesce($2::public.app_role, role), active = coalesce($3, active) where id = $1`,
    [id, fields.role ?? null, fields.active ?? null],
  );
}

export type Client = SupabaseClient<Database>;

export function anonClient(): Client {
  const { apiUrl, publishableKey } = localStack();
  return createClient<Database>(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function signIn(user: TestUser): Promise<Client> {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`sign-in failed for ${user.email}: ${error.message}`);
  return client;
}

// ---------------------------------------------------------------------------
// Master data fixtures
// ---------------------------------------------------------------------------
export async function categoryId(name = "Inverters"): Promise<string> {
  const { rows } = await db().query<{ id: string }>(`select id from public.categories where name = $1`, [name]);
  if (!rows[0]) throw new Error(`Seed category ${name} missing — run \`supabase db reset --local\``);
  return rows[0].id;
}

export async function createProduct(opts: { minimumStock?: number; active?: boolean } = {}): Promise<{ id: string; code: string }> {
  const code = `TST-${uid()}`;
  const { rows } = await db().query<{ id: string }>(
    `insert into public.products (code, category_id, model, minimum_stock, active)
     values ($1, $2, 'Produto de teste', $3, $4) returning id`,
    [code, await categoryId(), opts.minimumStock ?? 0, opts.active ?? true],
  );
  return { id: rows[0].id, code };
}

export async function createProject(status: "active" | "completed" | "cancelled" = "active"): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `insert into public.projects (name, status) values ($1, $2) returning id`,
    [`Projeto ${uid()}`, status],
  );
  return rows[0].id;
}

/** Ledger insert as superuser (the importer path). Still subject to all triggers. */
export async function insertMovementAsSuperuser(
  productId: string,
  type: string,
  quantity: number,
  userId: string,
): Promise<void> {
  await db().query(
    `insert into public.stock_movements (product_id, type, quantity, user_id) values ($1, $2, $3, $4)`,
    [productId, type, quantity, userId],
  );
}

export async function balanceOf(productId: string): Promise<{ balance: number; status: string }> {
  const { rows } = await db().query<{ balance: number; status: string }>(
    `select balance, status from public.product_stock where id = $1`,
    [productId],
  );
  return rows[0];
}

/** Returns the Postgres error (code/message) thrown by `fn`, failing if it resolves. */
export async function pgError(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error("Expected a database error, but the statement succeeded");
}
