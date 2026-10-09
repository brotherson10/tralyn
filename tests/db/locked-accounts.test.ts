import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createUser, db, pgError, signIn, type TestUser } from "./helpers";

/**
 * Shared (locked) accounts: private.locked_auth_users + the BEFORE UPDATE
 * trigger on auth.users. Exercised through the real Auth API (GoTrue) with the
 * public key, plus SQL for the roles the API never exposes.
 */

let locked: TestUser;
let control: TestUser;

const credentials = async (id: string) =>
  (
    await db().query<{ email: string; encrypted_password: string; email_change: string; phone: string | null }>(
      `select email, encrypted_password, email_change, phone from auth.users where id = $1`,
      [id],
    )
  ).rows[0];

const newPassword = () => `Nova-${randomUUID()}`;
const newEmail = () => `taken-${randomUUID().slice(0, 8)}@test.local`;

beforeAll(async () => {
  [locked, control] = await Promise.all([createUser("viewer"), createUser("viewer")]);
  await db().query(`insert into private.locked_auth_users (user_id, reason) values ($1, 'Conta demo partilhada (teste)')`, [locked.id]);
});

afterAll(closeDb);

describe("locked account: normal use keeps working", () => {
  it("signs in, reads, refreshes and signs out", async () => {
    const client = await signIn(locked);
    expect((await client.auth.getUser()).data.user?.id).toBe(locked.id);
    expect((await client.from("product_stock").select("id").limit(1)).error).toBeNull();

    const refreshed = await client.auth.refreshSession();
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session).not.toBeNull();

    expect((await client.auth.signOut()).error).toBeNull();
    // Signing in again records last_sign_in_at (an UPDATE on auth.users) without tripping the lock.
    await signIn(locked);
    const { rows } = await db().query(`select last_sign_in_at from auth.users where id = $1`, [locked.id]);
    expect(rows[0].last_sign_in_at).not.toBeNull();
  });

  it("non-credential updates (user metadata) are still allowed", async () => {
    const client = await signIn(locked);
    const { error } = await client.auth.updateUser({ data: { theme: "dark" } });
    expect(error).toBeNull();
  });
});

describe("locked account: credentials cannot be changed through the Auth API", () => {
  it("refuses a password change; the old password keeps working", async () => {
    const before = await credentials(locked.id);
    const client = await signIn(locked);
    const { error } = await client.auth.updateUser({ password: newPassword() });
    expect(error).not.toBeNull();
    expect(await credentials(locked.id)).toEqual(before);
    await signIn(locked); // throws if the password changed
  });

  it("refuses to even start an e-mail change (no pending change, no tokens)", async () => {
    const before = await credentials(locked.id);
    const client = await signIn(locked);
    const { error } = await client.auth.updateUser({ email: newEmail() });
    expect(error).not.toBeNull();
    expect(await credentials(locked.id)).toEqual(before);
    const { rows } = await db().query(`select email_change_token_new, email_change_token_current from auth.users where id = $1`, [locked.id]);
    expect(rows[0]).toEqual({ email_change_token_new: "", email_change_token_current: "" });
  });
});

describe("control: an unlocked account shows why the lock is needed", () => {
  it("can change its own password and start an e-mail change", async () => {
    const client = await signIn(control);
    const password = newPassword();
    expect((await client.auth.updateUser({ password })).error).toBeNull();
    await signIn({ ...control, password });

    // With "secure e-mail change" on, the change waits for confirmation from
    // both addresses; without it, the new (attacker-owned) address suffices.
    const email = newEmail();
    expect((await client.auth.updateUser({ email })).error).toBeNull();
    const after = await credentials(control.id);
    expect(after.email).toBe(control.email);
    expect(after.email_change).toBe(email);
  });
});

describe("locked account: direct SQL is refused too", () => {
  const columns = [
    ["encrypted_password", `extensions.crypt('x-${randomUUID()}', extensions.gen_salt('bf'))`],
    ["email", `'sql-${randomUUID().slice(0, 8)}@test.local'`],
    ["email_change", `'pending-${randomUUID().slice(0, 8)}@test.local'`],
    ["email_change_token_new", `'token'`],
    ["phone", `'3519${String(Date.now()).slice(-8)}'`],
    ["phone_change", `'3518${String(Date.now()).slice(-8)}'`],
  ] as const;

  // The Auth service (supabase_auth_admin, also behind the dashboard and the
  // Admin API) is covered by the API tests above; here, the database owner.
  it.each(columns)("rejects a direct SQL change to %s, even by the database owner", async (column, value) => {
    const error = await pgError(() => db().query(`update auth.users set ${column} = ${value} where id = $1`, [locked.id]));
    expect(error.message).toBe("LOCKED_ACCOUNT");
  });

  it("does not affect unlocked accounts", async () => {
    const phone = `3519${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
    await db().query(`update auth.users set phone = $2 where id = $1`, [control.id, phone]);
    expect((await credentials(control.id)).phone).toBe(phone);
  });
});

describe("lock table", () => {
  it("is not readable or writable by API roles", async () => {
    for (const role of ["anon", "authenticated", "service_role"]) {
      const client = await db().connect();
      try {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        const read = await pgError(() => client.query(`select * from private.locked_auth_users`));
        expect(read.code, role).toBe("42501");
      } finally {
        await client.query("rollback");
        client.release();
      }
    }
  });

  it("administrative recovery: unlock, change, re-lock", async () => {
    const user = await createUser("viewer");
    await db().query(`insert into private.locked_auth_users (user_id, reason) values ($1, 'teste')`, [user.id]);
    const password = newPassword();
    const change = () => db().query(`update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')) where id = $1`, [user.id, password]);

    expect((await pgError(change)).message).toBe("LOCKED_ACCOUNT");
    await db().query(`delete from private.locked_auth_users where user_id = $1`, [user.id]);
    await change();
    await db().query(`insert into private.locked_auth_users (user_id, reason) values ($1, 'teste')`, [user.id]);
    await signIn({ ...user, password });
  });

  it("removes the lock when the auth user is deleted", async () => {
    const user = await createUser("viewer");
    await db().query(`insert into private.locked_auth_users (user_id, reason) values ($1, 'teste')`, [user.id]);
    await db().query(`delete from auth.users where id = $1`, [user.id]);
    const { rows } = await db().query(`select count(*)::int as n from private.locked_auth_users where user_id = $1`, [user.id]);
    expect(rows[0].n).toBe(0);
  });

  it("requires a non-blank reason", async () => {
    const user = await createUser("viewer");
    const error = await pgError(() => db().query(`insert into private.locked_auth_users (user_id, reason) values ($1, '  ')`, [user.id]));
    expect(error.code).toBe("23514");
  });
});
