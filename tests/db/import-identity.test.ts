import { execFileSync, execSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { assertLocalTarget, BAN_DURATION, IMPORT_IDENTITY, identityProblems } from "../../scripts/import-identity/identity";
import {
  probeAuthenticationBlocked,
  ProvisionAbortedError,
  provisionImportIdentity,
  readIdentity,
  type AdminClient,
} from "../../scripts/import-identity/provision";
import { closeDb, db, pgError } from "./helpers";

/**
 * Provisioning of the technical import identity against the LOCAL stack.
 * Uses the local CLI's default admin key (read from `supabase status` after
 * checking the target is local). Every test leaves no identity behind.
 */

function localStack() {
  const raw = execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let status: Record<string, string>;
  try {
    status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  } catch {
    // The parser message may quote part of the output (keys): never surface it.
    throw new Error("Saída de `supabase status` inválida.");
  }
  assertLocalTarget(status.API_URL);
  return { apiUrl: status.API_URL, secretKey: status.SECRET_KEY, publishableKey: status.PUBLISHABLE_KEY };
}

const stack = localStack();
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };
const newAdmin = (): AdminClient => createClient<Database>(stack.apiUrl, stack.secretKey, clientOptions);
const newPublic = () => createClient(stack.apiUrl, stack.publishableKey, clientOptions);
const admin = newAdmin();

/** Hard-deletes the identity (only possible while nothing references it). */
async function removeIdentity() {
  for (const user of (await readIdentity(admin)).users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(`cleanup failed: ${error.message}`);
  }
}

async function profileRow(id: string) {
  const { rows } = await db().query(`select name, role, active, updated_at from public.profiles where id = $1`, [id]);
  return rows[0];
}

beforeAll(removeIdentity);

afterAll(async () => {
  await removeIdentity();
  expect((await readIdentity(admin)).users).toEqual([]);
  await closeDb();
});

describe("provisioning", () => {
  let userId: string;

  it("A/F/G/H) first run creates the exact expected identity", async () => {
    const result = await provisionImportIdentity(admin);
    expect(result.outcome).toBe("created");
    userId = result.userId;

    const snapshot = await readIdentity(admin);
    expect(identityProblems(snapshot, new Date())).toEqual([]);
    expect(snapshot.users).toHaveLength(1);
    expect(snapshot.users[0]).toMatchObject({ id: userId, email: IMPORT_IDENTITY.email, lastSignInAt: null });
    expect(snapshot.profile).toEqual({ id: userId, name: "Importação de dados", role: "viewer", active: false });
    const banYears = (Date.parse(snapshot.users[0].bannedUntil!) - Date.now()) / (365 * 24 * 3600 * 1000);
    expect(banYears).toBeGreaterThan(99);
  });

  it("B) second run is idempotent: same id, nothing modified, no duplicate", async () => {
    const before = await profileRow(userId);
    const authBefore = (await admin.auth.admin.getUserById(userId)).data.user?.updated_at;

    const result = await provisionImportIdentity(admin);
    expect(result).toEqual({ outcome: "already_present", userId });

    expect(await profileRow(userId)).toEqual(before);
    expect((await admin.auth.admin.getUserById(userId)).data.user?.updated_at).toBe(authBefore);
    expect((await readIdentity(admin)).users).toHaveLength(1);
  });

  it("D) password login is impossible (banned, no password, no session)", async () => {
    expect(await probeAuthenticationBlocked(newPublic())).toBeNull();
    const { data, error } = await newPublic().auth.signInWithPassword({
      email: IMPORT_IDENTITY.email,
      password: randomBytes(24).toString("base64url"),
    });
    expect(error?.code).toBe("user_banned");
    expect(data.session).toBeNull();
  });

  it("E) magic-link and recovery codes cannot open a session", async () => {
    for (const type of ["magiclink", "recovery"] as const) {
      const link = await admin.auth.admin.generateLink({ type, email: IMPORT_IDENTITY.email });
      expect(link.error, type).toBeNull();
      const verify = await newPublic().auth.verifyOtp({
        email: IMPORT_IDENTITY.email,
        token: link.data.properties!.email_otp,
        type: type === "magiclink" ? "email" : "recovery",
      });
      expect(verify.error?.code, type).toBe("user_banned");
      expect(verify.data.session, type).toBeNull();
    }
    const { rows } = await db().query(`select count(*)::int as n from auth.sessions where user_id = $1`, [userId]);
    expect(rows[0].n).toBe(0);
    expect((await readIdentity(admin)).users[0].lastSignInAt).toBeNull();
  });

  it("I/J) can be referenced by stock_movements and import_batches, and then cannot be deleted (rolled back)", async () => {
    const client = await db().connect();
    try {
      await client.query("begin");
      const category = await client.query<{ id: string }>(`select id from public.categories where prefix = 'INV'`);
      const product = await client.query<{ id: string }>(
        `insert into public.products (code, category_id, brand, model) values ($1, $2, 'Teste', 'Identidade') returning id`,
        [`INV-${String(Math.floor(Math.random() * 900000) + 100000)}`, category.rows[0].id],
      );
      await client.query(
        `insert into public.stock_movements (product_id, type, quantity, user_id, source_reference)
         values ($1, 'OPENING_BALANCE', 2, $2, $3)`,
        [product.rows[0].id, userId, `test:identity:${randomUUID()}`],
      );
      await client.query(
        `insert into public.import_batches (source_file, source_sha256, import_version, executed_by)
         values ('teste.xlsx', $1, 'TEST', $2)`,
        [createHash("sha256").update(randomUUID()).digest("hex"), userId],
      );
      // Negative check only, inside the rolled-back transaction.
      const error = await pgError(() => client.query(`delete from auth.users where id = $1`, [userId]));
      expect(error.code).toBe("23503");
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect((await readIdentity(admin)).users).toHaveLength(1);
  });
});

describe("C) divergent identity → abort, never corrected", () => {
  let userId: string;

  beforeAll(async () => {
    userId = (await provisionImportIdentity(admin)).userId;
  });

  const profileMutations: [string, string, string][] = [
    ["active = true", `update public.profiles set active = true where id = $1`, `update public.profiles set active = false where id = $1`],
    ["role = admin", `update public.profiles set role = 'admin' where id = $1`, `update public.profiles set role = 'viewer' where id = $1`],
    ["role = operator", `update public.profiles set role = 'operator' where id = $1`, `update public.profiles set role = 'viewer' where id = $1`],
    ["different name", `update public.profiles set name = 'Demo Operator' where id = $1`, `update public.profiles set name = 'Importação de dados' where id = $1`],
  ];

  it.each(profileMutations)("%s", async (label, mutate, restore) => {
    await db().query(mutate, [userId]);
    const divergent = await profileRow(userId);
    try {
      await expect(provisionImportIdentity(admin)).rejects.toBeInstanceOf(ProvisionAbortedError);
      // Nothing was "fixed".
      expect(await profileRow(userId), label).toEqual(divergent);
    } finally {
      await db().query(restore, [userId]);
    }
    expect(identityProblems(await readIdentity(admin), new Date())).toEqual([]);
  });

  it("ban lifted", async () => {
    await admin.auth.admin.updateUserById(userId, { ban_duration: "none" });
    try {
      await expect(provisionImportIdentity(admin)).rejects.toThrow(/não bloqueada/);
      expect((await readIdentity(admin)).users[0].bannedUntil).toBeNull(); // not re-banned silently
    } finally {
      await admin.auth.admin.updateUserById(userId, { ban_duration: BAN_DURATION });
    }
    expect(identityProblems(await readIdentity(admin), new Date())).toEqual([]);
  });

  it("marker removed (foreign account with the same e-mail)", async () => {
    await admin.auth.admin.updateUserById(userId, { app_metadata: { system_identity: null } });
    try {
      await expect(provisionImportIdentity(admin)).rejects.toThrow(/marcador/);
    } finally {
      await admin.auth.admin.updateUserById(userId, { app_metadata: { system_identity: IMPORT_IDENTITY.marker.value } });
    }
    expect(identityProblems(await readIdentity(admin), new Date())).toEqual([]);
  });
});

describe("concurrency and CLI", () => {
  it("two simultaneous runs create exactly one identity", async () => {
    await removeIdentity();
    const results = await Promise.all([provisionImportIdentity(newAdmin()), provisionImportIdentity(newAdmin())]);
    expect(results.map((r) => r.outcome).sort()).toEqual(["already_present", "created"]);
    expect(results[0].userId).toBe(results[1].userId);
    const snapshot = await readIdentity(admin);
    expect(snapshot.users).toHaveLength(1);
    expect(identityProblems(snapshot, new Date())).toEqual([]);
  });

  const runCli = () => {
    const output = execFileSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/provision-import-identity.ts"], {
      encoding: "utf8",
      timeout: 120_000,
    });
    return JSON.parse(output);
  };

  it("the CLI creates on a clean stack, then reports already_present; no secrets in its output", async () => {
    await removeIdentity();
    const first = runCli();
    expect(first).toMatchObject({ target: "local", outcome: "created", email: IMPORT_IDENTITY.email, passwordSet: false, authenticationBlocked: true });
    expect(first.profile).toMatchObject({ name: "Importação de dados", role: "viewer", active: false });
    const second = runCli();
    expect(second).toMatchObject({ outcome: "already_present", userId: first.userId });
    const text = JSON.stringify([first, second]);
    expect(text).not.toMatch(/sb_secret_|sb_publishable_|eyJhbGciOi|password"\s*:\s*"/);
  });
});
