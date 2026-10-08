import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { assertLocalTarget, IMPORT_IDENTITY } from "../../scripts/import-identity/identity";
import {
  PREFLIGHT_SQL,
  redactSecrets,
  type Baseline,
  type LinkedProjectFacts,
  type PreflightFacts,
} from "../../scripts/import-identity/hosted";
import { ApplyRefusedError, checkExitCode, runApply, runCheck, type HostedDeps } from "../../scripts/import-identity/hosted-runtime";
import { readIdentity, type AdminClient } from "../../scripts/import-identity/provision";
import { TEST_HOSTED_PROJECT as PROJECT } from "../../scripts/import-identity/test-project";
import { closeDb, db } from "./helpers";

/**
 * The hosted CHECK/APPLY flow exercised ONLY against the LOCAL stack: the
 * preflight SQL runs on the local database, the linked project is a test
 * double and the admin client points at 127.0.0.1. Nothing here reaches the
 * hosted project.
 */

function localStack() {
  const raw = execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let status: Record<string, string>;
  try {
    status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  } catch {
    throw new Error("Saída de `supabase status` inválida.");
  }
  assertLocalTarget(status.API_URL);
  return { apiUrl: status.API_URL, secretKey: status.SECRET_KEY };
}

const stack = localStack();
const newAdmin = (): AdminClient =>
  createClient<Database>(stack.apiUrl, stack.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = newAdmin();

const canonicalLink = (): LinkedProjectFacts => ({
  linkedRefFile: PROJECT.ref,
  projects: [{ ref: PROJECT.ref, name: PROJECT.name, status: "ACTIVE_HEALTHY", linked: true }],
});

const readLocalFacts = async (): Promise<PreflightFacts> => (await db().query<{ facts: PreflightFacts }>(PREFLIGHT_SQL)).rows[0].facts;

/** Local baseline = current local counts (the local DB keeps other tests' data). */
let baseline: Baseline;

const deps = (overrides: Partial<HostedDeps> = {}): HostedDeps => ({
  project: PROJECT,
  readFacts: readLocalFacts,
  readLinkedProject: async () => canonicalLink(),
  admin,
  baseline,
  ...overrides,
});

const CONFIRM = { project: PROJECT.ref, identity: IMPORT_IDENTITY.email };

async function removeIdentity() {
  for (const user of (await readIdentity(admin)).users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(`cleanup failed: ${error.message}`);
  }
}

async function authUserCount() {
  return (await db().query<{ n: number }>(`select count(*)::int as n from auth.users`)).rows[0].n;
}

/** Admin double whose writes after createUser fail (simulates a partial failure). */
function failingAfterCreate(): AdminClient {
  const real = newAdmin();
  const auth = new Proxy(real.auth.admin, {
    get(target, prop, receiver) {
      if (prop === "updateUserById") return async () => ({ data: { user: null }, error: new Error("falha simulada após createUser") });
      return Reflect.get(target, prop, receiver);
    },
  });
  const from = (table: string) => {
    const query = real.from(table as "profiles");
    return new Proxy(query, {
      get(target, prop, receiver) {
        if (prop === "update") return () => { throw new Error("falha simulada após createUser"); };
        return Reflect.get(target, prop, receiver);
      },
    });
  };
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "auth") return new Proxy(real.auth, { get: (t, p, r) => (p === "admin" ? auth : Reflect.get(t, p, r)) });
      if (prop === "from") return from;
      return Reflect.get(target, prop, receiver);
    },
  }) as AdminClient;
}

beforeAll(async () => {
  await removeIdentity();
  const facts = await readLocalFacts();
  baseline = { authUsers: facts.auth_user_ids.length, profiles: facts.profiles, emptyTables: [] };
});

afterAll(async () => {
  await removeIdentity();
  expect((await readIdentity(admin)).users).toEqual([]);
  await closeDb();
});

describe("CHECK (read-only)", () => {
  beforeEach(removeIdentity);

  it("absent identity on the baseline → ready_to_create, admin key cross-checked, nothing written", async () => {
    const before = await authUserCount();
    const report = await runCheck(deps());
    expect(report).toMatchObject({ ok: true, state: "ready_to_create", keyCheck: "ok", problems: [] });
    expect(await authUserCount()).toBe(before);
  });

  it("exit code: valid CHECK → 0, invalid CHECK → 1", async () => {
    expect(checkExitCode(await runCheck(deps()))).toBe(0);
    expect(checkExitCode(await runCheck(deps({ readLinkedProject: async () => ({ ...canonicalLink(), linkedRefFile: null }) })))).toBe(1);
  });

  it("without a key → not_provided (still read-only)", async () => {
    expect(await runCheck(deps({ admin: null }))).toMatchObject({ ok: true, keyCheck: "not_provided" });
  });

  it("wrong linked project → fails", async () => {
    const report = await runCheck(deps({ readLinkedProject: async () => ({ ...canonicalLink(), linkedRefFile: "otherprojectref" }) }));
    expect(report.ok).toBe(false);
    expect(report.state).toBeNull();
  });

  it("admin key for a different project (different user set) → keyCheck failed", async () => {
    const report = await runCheck(
      deps({ readFacts: async () => ({ ...(await readLocalFacts()), auth_user_ids: ["99999999-9999-4999-8999-999999999999"] }) }),
    );
    expect(report.keyCheck).toBe("failed");
    expect(report.ok).toBe(false);
  });

  it("baseline drift (an unexpected extra user) → fails", async () => {
    const report = await runCheck(deps({ baseline: { ...baseline, authUsers: baseline.authUsers - 1 } }));
    expect(report.ok).toBe(false);
  });
});

describe("APPLY refusals write nothing", () => {
  beforeEach(removeIdentity);

  it.each([
    ["no confirmation", { project: null, identity: null }],
    ["project only", { project: PROJECT.ref, identity: null }],
    ["wrong project", { project: "otherprojectref", identity: IMPORT_IDENTITY.email }],
    ["wrong identity", { project: PROJECT.ref, identity: "outro@tralyn.invalid" }],
  ])("%s → refused", async (_label, confirmation) => {
    const before = await authUserCount();
    await expect(runApply(deps(), confirmation)).rejects.toBeInstanceOf(ApplyRefusedError);
    expect(await authUserCount()).toBe(before);
  });

  it("no admin key → refused", async () => {
    await expect(runApply(deps({ admin: null }), CONFIRM)).rejects.toThrow(/Credencial administrativa ausente/);
    expect((await readIdentity(admin)).users).toEqual([]);
  });

  it("wrong linked project → refused before writing", async () => {
    await expect(runApply(deps({ readLinkedProject: async () => ({ ...canonicalLink(), linkedRefFile: null }) }), CONFIRM)).rejects.toThrow(
      /Preflight falhou/,
    );
    expect((await readIdentity(admin)).users).toEqual([]);
  });

  it("preflight failure (non-empty table required empty) → refused before writing", async () => {
    // Own product (no movements, deleted afterwards): independent of test order / a freshly reset DB.
    const { rows } = await db().query<{ id: string }>(
      `insert into public.products (code, category_id, model)
       values ('PRE-' || upper(substr(md5(random()::text), 1, 6)), (select id from public.categories where name = 'Inverters'), 'Alheio') returning id`,
    );
    try {
      await expect(runApply(deps({ baseline: { ...baseline, emptyTables: ["products"] } }), CONFIRM)).rejects.toThrow(/products/);
      expect((await readIdentity(admin)).users).toEqual([]);
    } finally {
      await db().query(`delete from public.products where id = $1`, [rows[0].id]);
    }
  });

  it("admin key mismatch → refused before writing", async () => {
    const readFacts = async () => ({ ...(await readLocalFacts()), auth_user_ids: ["99999999-9999-4999-8999-999999999999"] });
    await expect(runApply(deps({ readFacts, baseline: { ...baseline, authUsers: 1 } }), CONFIRM)).rejects.toBeInstanceOf(ApplyRefusedError);
    expect((await readIdentity(admin)).users).toEqual([]);
  });
});

describe("APPLY on a conforming target", () => {
  let userId: string;

  beforeAll(removeIdentity);

  it("creates exactly the canonical identity (auth user + inactive viewer profile)", async () => {
    const result = await runApply(deps(), CONFIRM);
    expect(result.outcome).toBe("created");
    expect(result.before.state).toBe("ready_to_create");
    // Relative baseline: exactly +1 auth user and +1 profile, nothing else.
    expect(result.before).toMatchObject({ authUsers: baseline.authUsers, profiles: baseline.profiles });
    expect(result.after).toMatchObject({
      ok: true,
      state: "already_present",
      authUsers: baseline.authUsers + 1,
      profiles: baseline.profiles + 1,
    });
    userId = result.userId;
    const { rows } = await db().query(`select name, role, active from public.profiles where id = $1`, [userId]);
    expect(rows[0]).toEqual({ name: "Importação de dados", role: "viewer", active: false });
  });

  it("CHECK then reports already_present; a second APPLY changes nothing", async () => {
    expect(await runCheck(deps())).toMatchObject({ ok: true, state: "already_present" });
    const before = await db().query(`select updated_at from public.profiles where id = $1`, [userId]);
    const second = await runApply(deps(), CONFIRM);
    expect(second).toMatchObject({ outcome: "already_present", userId });
    expect((await db().query(`select updated_at from public.profiles where id = $1`, [userId])).rows).toEqual(before.rows);
    expect((await readIdentity(admin)).users).toHaveLength(1);
  });

  it.each([
    ["active = true", `update public.profiles set active = true where id = $1`, `update public.profiles set active = false where id = $1`],
    ["role = admin", `update public.profiles set role = 'admin' where id = $1`, `update public.profiles set role = 'viewer' where id = $1`],
  ])("divergent (%s) → CHECK fails, APPLY aborts and fixes nothing", async (_label, mutate, restore) => {
    await db().query(mutate, [userId]);
    try {
      const divergent = (await db().query(`select role, active, updated_at from public.profiles where id = $1`, [userId])).rows;
      expect((await runCheck(deps())).ok).toBe(false);
      await expect(runApply(deps(), CONFIRM)).rejects.toBeInstanceOf(ApplyRefusedError);
      expect((await db().query(`select role, active, updated_at from public.profiles where id = $1`, [userId])).rows).toEqual(divergent);
    } finally {
      await db().query(restore, [userId]);
    }
    expect(await runCheck(deps())).toMatchObject({ ok: true, state: "already_present" });
  });
});

describe("partial failure and concurrency", () => {
  beforeEach(removeIdentity);

  it("failure after createUser → APPLY throws; next CHECK/APPLY detect drift; nothing deleted or recreated", async () => {
    await expect(runApply(deps({ admin: failingAfterCreate() }), CONFIRM)).rejects.toThrow();
    const snapshot = await readIdentity(admin);
    expect(snapshot.users).toHaveLength(1); // the half-created account is kept, not deleted
    const id = snapshot.users[0].id;

    const check = await runCheck(deps());
    expect(check.ok).toBe(false);
    await expect(runApply(deps(), CONFIRM)).rejects.toBeInstanceOf(ApplyRefusedError);

    const after = await readIdentity(admin);
    expect(after.users.map((u) => u.id)).toEqual([id]); // not recreated
    expect(after.users[0].bannedUntil).not.toBeNull(); // banned since creation
    expect(after.profile).toEqual(snapshot.profile); // not silently fixed
  });

  it("two simultaneous APPLY runs → exactly one identity", async () => {
    const results = await Promise.allSettled([runApply(deps({ admin: newAdmin() }), CONFIRM), runApply(deps({ admin: newAdmin() }), CONFIRM)]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect((await readIdentity(admin)).users).toHaveLength(1);
    expect(await runCheck(deps())).toMatchObject({ ok: true, state: "already_present" });
  });
});

describe("secret hygiene", () => {
  it("errors that echo the admin key are masked before printing", async () => {
    const leaky = new Proxy(admin, {
      get(target, prop, receiver) {
        if (prop === "auth") {
          return { admin: { listUsers: async () => { throw new Error(`boom apikey=${stack.secretKey}`); } } };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as AdminClient;
    const error = await runCheck(deps({ admin: leaky })).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    const printed = redactSecrets((error as Error).message, [stack.secretKey]);
    expect(printed).not.toContain(stack.secretKey);
    expect(printed).toContain("[REDACTED]");
  });
});
