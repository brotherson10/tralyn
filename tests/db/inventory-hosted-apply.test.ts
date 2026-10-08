import { execSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { PREFLIGHT_SQL, type LinkedProjectFacts, type PreflightFacts } from "../../scripts/import-identity/hosted";
import { TEST_HOSTED_PROJECT as PROJECT } from "../../scripts/import-identity/test-project";
import { assertLocalTarget } from "../../scripts/import-identity/identity";
import { provisionImportIdentity, readIdentity, type AdminClient } from "../../scripts/import-identity/provision";
import {
  deriveApplyInvariants,
  HostedApplyUncertainError,
  measureState,
  runHostedApply,
  type ApplyInvariants,
  type HostedApplyDeps,
} from "../../scripts/inventory-import/hosted-apply";
import { HostedImportError, type TableCounts } from "../../scripts/inventory-import/hosted-session";
import type { ImportPlan } from "../../scripts/inventory-import/model";
import { buildImportPlan } from "../../scripts/inventory-import/pipeline";
import { buildFixture, type FixtureSheets } from "../../scripts/inventory-import/test-fixture";
import { closeDb, createUser, db, localStack } from "./helpers";

/**
 * The hosted APPLY orchestration exercised ONLY against the LOCAL stack
 * (connections to 127.0.0.1, linked project and CLI facts are local doubles).
 *
 * The happy path really COMMITs synthetic data locally. Because the ledger and
 * the import audit are immutable, purgeCommitted() removes exactly the rows a
 * test committed, temporarily disabling ONLY the immutability triggers inside
 * one transaction (test cleanup on the local DB; the importer never does this).
 */

const DB_URL = localStack().dbUrl;

function adminClient(): AdminClient {
  const raw = execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let status: Record<string, string>;
  try {
    status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  } catch {
    throw new Error("Saída de `supabase status` inválida.");
  }
  assertLocalTarget(status.API_URL);
  return createClient<Database>(status.API_URL, status.SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
const admin = adminClient();

function syntheticPlan(): ImportPlan {
  const tag = `P${randomBytes(4).toString("hex").toUpperCase().slice(0, 5)}`;
  const swap = (s: string) =>
    s.replaceAll("CTA", `${tag}A`).replaceAll("CTB", `${tag}B`).replaceAll("Categoria ", `Categoria ${tag} `).replaceAll("Depósito", `Depósito ${tag}`);
  const fixture = buildFixture(
    (sheets: FixtureSheets) => {
      for (const rows of Object.values(sheets)) for (const row of rows) row.forEach((v, i) => typeof v === "string" && (row[i] = swap(v)));
    },
    {
      expectations: (e) => {
        e.realLocations = e.realLocations.map(swap);
        e.initialByCategory = Object.fromEntries(Object.entries(e.initialByCategory).map(([k, v]) => [swap(k), v]));
        e.specialProducts = e.specialProducts.map((p) => ({ ...p, code: swap(p.code) }));
      },
    },
  );
  const result = buildImportPlan({ fileName: fixture.fileName, bytes: fixture.bytes }, fixture.expectations);
  if (!result.ok) throw new Error("synthetic plan invalid");
  return result.plan;
}

const IMMUTABILITY_TRIGGERS = [
  ["public.stock_movements", "stock_movements_immutable_rows"],
  ["public.import_records", "import_records_immutable_rows"],
  ["public.import_batches", "import_batches_immutable_rows"],
] as const;

/** Removes exactly what a test committed (by batch id and the plan's natural keys). */
async function purgeCommitted(plan: ImportPlan, extraProductCodes: string[] = []) {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    for (const [table, trigger] of IMMUTABILITY_TRIGGERS) await client.query(`alter table ${table} disable trigger ${trigger}`);
    const batches = await client.query<{ batch_id: string }>(
      `select distinct batch_id from public.import_records where source_reference = any($1)`,
      [plan.records.map((r) => r.sourceReference)],
    );
    const batchIds = batches.rows.map((r) => r.batch_id);
    await client.query(`delete from public.import_records where batch_id = any($1::uuid[])`, [batchIds]);
    await client.query(`delete from public.import_batches where id = any($1::uuid[])`, [batchIds]);
    await client.query(`delete from public.stock_movements where source_reference = any($1)`, [plan.movements.map((m) => m.sourceReference)]);
    await client.query(`delete from public.products where code = any($1)`, [[...plan.products.map((p) => p.code), ...extraProductCodes]]);
    await client.query(`delete from public.locations where code = any($1)`, [plan.locations.map((l) => l.code)]);
    await client.query(`delete from public.categories where prefix = any($1)`, [plan.categories.map((c) => c.prefix)]);
    for (const [table, trigger] of IMMUTABILITY_TRIGGERS) await client.query(`alter table ${table} enable trigger ${trigger}`);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  const { rows } = await db().query<{ tgname: string; tgenabled: string }>(
    `select tgname, tgenabled from pg_trigger where tgname = any($1)`,
    [IMMUTABILITY_TRIGGERS.map(([, t]) => t)],
  );
  expect(rows.map((r) => [r.tgname, r.tgenabled]).sort()).toEqual(IMMUTABILITY_TRIGGERS.map(([, t]) => [t, "O"]).sort());
}

async function counts(): Promise<TableCounts> {
  return (await measureState(db())).counts;
}

const canonicalLink = (): LinkedProjectFacts => ({
  linkedRefFile: PROJECT.ref,
  projects: [{ ref: PROJECT.ref, name: PROJECT.name, status: "ACTIVE_HEALTHY", linked: true }],
});
const readLocalFacts = async (): Promise<PreflightFacts> => (await db().query<{ facts: PreflightFacts }>(PREFLIGHT_SQL)).rows[0].facts;

let createdIdentity = false;
let connections = 0;

/** Deps relative to the CURRENT local state (the shared test DB holds other data). */
async function deps(plan: ImportPlan, overrides: Partial<HostedApplyDeps> = {}): Promise<HostedApplyDeps> {
  const state = await measureState(db());
  return {
    connect: async () => {
      connections += 1;
      const client = new pg.Client({ connectionString: DB_URL });
      await client.connect();
      return client;
    },
    project: PROJECT,
    readLinkedProject: async () => canonicalLink(),
    readCliFacts: readLocalFacts,
    identityBaseline: { authUsers: state.counts.auth_users - 1, profiles: state.counts.profiles - 1, emptyTables: [] },
    dataBaseline: state.counts,
    importOptions: { policy: "scoped" },
    invariants: deriveApplyInvariants(state, plan),
    ...overrides,
  };
}

async function expectRolledBack(run: () => Promise<unknown>, stage: string, connectionsUsed: number, message?: RegExp) {
  const before = await counts();
  const start = connections;
  const error = await run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HostedImportError);
  expect((error as HostedImportError).stage).toBe(stage);
  if (message) expect((error as Error).message).toMatch(message);
  expect(connections - start).toBe(connectionsUsed);
  expect(await counts()).toEqual(before);
  return error as HostedImportError;
}

beforeAll(async () => {
  createdIdentity = (await readIdentity(admin)).users.length === 0;
  await provisionImportIdentity(admin);
});

afterAll(async () => {
  if (createdIdentity) {
    for (const user of (await readIdentity(admin)).users) {
      const { error } = await admin.auth.admin.deleteUser(user.id);
      if (error) throw new Error(`cleanup failed: ${error.message}`);
    }
  }
  await closeDb();
});

describe("refusals before any write", () => {
  it("D: baseline not as expected (not pristine) → refused at precheck", async () => {
    const plan = syntheticPlan();
    const d = await deps(plan);
    await expectRolledBack(async () => runHostedApply(plan, { ...d, dataBaseline: { ...d.dataBaseline, products: d.dataBaseline.products + 1 } }), "pré-check", 1);
  });

  it("E: pg connection bound to a different project than the linked CLI → refused", async () => {
    // The simulated "other project" swaps every non-technical user id, so at least one
    // such user must exist (a freshly reset database may hold only the technical identity).
    await createUser("viewer");
    const plan = syntheticPlan();
    const readCliFacts = async () => {
      const facts = await readLocalFacts();
      const technical = facts.identity_users[0].id;
      return { ...facts, auth_user_ids: facts.auth_user_ids.map((id) => (id === technical ? id : randomUUID())) };
    };
    await expectRolledBack(async () => runHostedApply(plan, await deps(plan, { readCliFacts })), "binding", 1);
  });

  it("E: wrong linked project → refused before any connection", async () => {
    const plan = syntheticPlan();
    await expectRolledBack(async () => runHostedApply(plan, await deps(plan, { readLinkedProject: async () => ({ ...canonicalLink(), linkedRefFile: "otherref" }) })), "projeto ligado", 0);
  });

  it("F: technical identity invalid → refused before any connection", async () => {
    const plan = syntheticPlan();
    const readCliFacts = async () => ({ ...(await readLocalFacts()), identity_users: [] });
    await expectRolledBack(async () => runHostedApply(plan, await deps(plan, { readCliFacts })), "identidade técnica (CLI)", 0);
  });
});

describe("failures after BEGIN → ROLLBACK, nothing persisted", () => {
  it("G: error during the import (divergent existing product) → rollback + read-only postcheck", async () => {
    const plan = syntheticPlan();
    const last = plan.products.at(-1)!;
    await db().query(
      `insert into public.products (code, category_id, model) values ($1, (select id from public.categories where name = 'Inverters'), 'Outro')`,
      [last.code],
    );
    try {
      const error = await expectRolledBack(async () => runHostedApply(plan, await deps(plan)), "apply", 3, /produtos/);
      expect(error.postcheck).toMatchObject({ backToBaseline: true, identityUnchanged: true });
      const leftovers = await db().query(`select count(*)::int as n from public.categories where prefix = any($1)`, [plan.categories.map((c) => c.prefix)]);
      expect(leftovers.rows[0].n).toBe(0);
    } finally {
      await db().query(`delete from public.products where code = $1`, [last.code]);
    }
  });

  it("H: reconciliation error → rollback", async () => {
    const plan = syntheticPlan();
    const d = await deps(plan, { importOptions: { policy: "scoped", expectations: { statusCounts: { OUT_OF_STOCK: 9, REORDER: 9, OK: 9 } } } });
    const error = await expectRolledBack(async () => runHostedApply(plan, d), "apply", 3, /reconciliação/);
    expect(error.postcheck?.backToBaseline).toBe(true);
  });

  it("H: any pre-COMMIT invariant off by one → no COMMIT, rollback", async () => {
    const plan = syntheticPlan();
    const d = await deps(plan);
    const invariants: ApplyInvariants = { ...d.invariants, totalStock: d.invariants.totalStock + 1 };
    const error = await expectRolledBack(async () => runHostedApply(plan, { ...d, invariants }), "invariantes pré-COMMIT", 3, /estoque total/);
    expect(error.postcheck).toMatchObject({ backToBaseline: true, identityUnchanged: true });
  });

  it("pristine policy on a target with foreign data → aborts inside the transaction, rollback", async () => {
    const plan = syntheticPlan();
    await expectRolledBack(async () => runHostedApply(plan, await deps(plan, { importOptions: { policy: "pristine" } })), "apply", 3, /preflight/);
  });
});

describe("I/J: happy path — BEGIN → import → invariants → COMMIT → post-COMMIT check", () => {
  it("commits exactly the plan, attributed to the technical identity, and verifies it on a new connection", async () => {
    const plan = syntheticPlan();
    const d = await deps(plan);
    const start = connections;
    try {
      const report = await runHostedApply(plan, d);
      expect(connections - start).toBe(3); // precheck, apply transaction, post-COMMIT check
      expect(report.committed).toBe(true);
      expect(report.inTransaction.batchRecords).toEqual({ created: 9, already_present: 0 });
      expect(report.postCommit.identityUnchanged).toBe(true);
      expect(report.postCommit.state).toEqual(report.gate.state);
      expect(report.postCommit.batch).toEqual({
        batchRecords: { created: 9, already_present: 0 },
        batchMovements: 3,
        movementsNotByIdentity: 0,
        batchExecutedByIdentity: true,
      });

      // Persisted (new connection): exactly the plan, nothing else.
      expect(await counts()).toEqual(d.invariants.counts);
      const codes = plan.products.map((p) => p.code);
      const persisted = await db().query(
        `select (select count(*)::int from public.categories where prefix = any($1)) as categories,
                (select count(*)::int from public.locations where code = any($2)) as locations,
                (select count(*)::int from public.products where code = any($3)) as products,
                (select count(*)::int from public.stock_movements m join public.products p on p.id = m.product_id where p.code = any($3)) as movements,
                (select coalesce(sum(balance), 0)::int from public.product_stock where code = any($3)) as stock,
                (select count(*)::int from public.import_records where batch_id = $4) as records,
                (select executed_by = $5 from public.import_batches where id = $4) as executed_by_identity,
                (select bool_and(m.user_id = $5) from public.stock_movements m join public.products p on p.id = m.product_id where p.code = any($3)) as movements_by_identity`,
        [plan.categories.map((c) => c.prefix), plan.locations.map((l) => l.code), codes, report.inTransaction.batchId, report.binding.identityId],
      );
      expect(persisted.rows[0]).toEqual({
        categories: 2,
        locations: 1,
        products: 3,
        movements: 3,
        stock: plan.reconciliation.finalQuantity,
        records: 9,
        executed_by_identity: true,
        movements_by_identity: true,
      });
    } finally {
      await purgeCommitted(plan);
    }
    expect(await counts()).toEqual(d.dataBaseline);
  });

  it("post-COMMIT verification that differs is reported for manual review (never repaired)", async () => {
    const plan = syntheticPlan();
    const d = await deps(plan);
    const intruder = `INT-${randomBytes(3).toString("hex").toUpperCase()}`;
    let opened = 0;
    const connect = async () => {
      opened += 1;
      if (opened === 3) {
        // Something changes the target right after COMMIT, before the verification connection.
        await db().query(
          `insert into public.products (code, category_id, model) values ($1, (select id from public.categories where name = 'Inverters'), 'Intruso')`,
          [intruder],
        );
      }
      return d.connect();
    };
    try {
      const error = await runHostedApply(plan, { ...d, connect }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HostedApplyUncertainError);
      expect((error as HostedApplyUncertainError).stage).toBe("pós-COMMIT");
      expect((error as Error).message).toMatch(/contagens/);
      // The committed import is still there: nothing was undone or "fixed".
      const kept = await db().query(`select count(*)::int as n from public.products where code = any($1)`, [plan.products.map((p) => p.code)]);
      expect(kept.rows[0].n).toBe(3);
    } finally {
      await purgeCommitted(plan, [intruder]);
    }
    expect(await counts()).toEqual(d.dataBaseline);
  });
});
