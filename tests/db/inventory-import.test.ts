import { execSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { assertLocalTarget } from "../../scripts/import-identity/identity";
import { provisionImportIdentity, readIdentity, type AdminClient } from "../../scripts/import-identity/provision";
import { CANONICAL_EXPECTATIONS, CANONICAL_WORKBOOK_PATH } from "../../scripts/inventory-import/expectations";
import {
  CANONICAL_DB_EXPECTATIONS,
  ImportAbortedError,
  importPlan,
  runImport,
  type ImportOptions,
} from "../../scripts/inventory-import/importer";
import type { ImportPlan } from "../../scripts/inventory-import/model";
import { buildImportPlan } from "../../scripts/inventory-import/pipeline";
import { buildFixture, type FixtureSheets } from "../../scripts/inventory-import/test-fixture";
import { closeDb, db, localStack } from "./helpers";

/**
 * The transactional importer against the LOCAL stack only. Imports run inside
 * transactions that are rolled back (the ledger is immutable, so nothing may
 * be committed here); the few deliberate failures leave nothing behind.
 */

const DB_URL = localStack().dbUrl;
const SCOPED: ImportOptions = { policy: "scoped" };

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

/** Synthetic plan with unique codes/prefixes per call (no collision with other data). */
function syntheticPlan(): ImportPlan {
  const tag = `Q${randomBytes(4).toString("hex").toUpperCase().slice(0, 5)}`;
  const swap = (s: string) =>
    s.replaceAll("CTA", `${tag}A`).replaceAll("CTB", `${tag}B`).replaceAll("Categoria ", `Categoria ${tag} `).replaceAll("Depósito", `Depósito ${tag}`);
  const fixture = buildFixture(
    (sheets: FixtureSheets) => {
      for (const rows of Object.values(sheets)) {
        for (const row of rows) row.forEach((v, i) => typeof v === "string" && (row[i] = swap(v)));
      }
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
  if (!result.ok) throw new Error(`synthetic plan invalid: ${JSON.stringify(result.errors)}`);
  return result.plan;
}

const canonicalPath = CANONICAL_WORKBOOK_PATH;
function canonicalPlan(): ImportPlan {
  const result = buildImportPlan({ fileName: CANONICAL_EXPECTATIONS.fileName, bytes: readFileSync(canonicalPath) });
  if (!result.ok) throw new Error("canonical plan invalid");
  return result.plan;
}

async function withTransaction<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

/** Runs fn inside a savepoint and always rolls the savepoint back. */
async function inSavepoint<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query("savepoint s");
  try {
    return await fn();
  } finally {
    await client.query("rollback to savepoint s");
  }
}

async function tableCounts() {
  const { rows } = await db().query<Record<string, number>>(
    `select (select count(*)::int from public.categories) as categories,
            (select count(*)::int from public.locations) as locations,
            (select count(*)::int from public.products) as products,
            (select count(*)::int from public.stock_movements) as stock_movements,
            (select count(*)::int from public.import_batches) as import_batches,
            (select count(*)::int from public.import_records) as import_records`,
  );
  return rows[0];
}

/**
 * Guarantees foreign data regardless of test order or a freshly reset DB: a
 * product outside any plan (no movements, so it can be deleted afterwards).
 */
async function withForeignProduct<T>(fn: () => Promise<T>): Promise<T> {
  const { rows } = await db().query<{ id: string }>(
    `insert into public.products (code, category_id, model) values ($1, (select id from public.categories where name = 'Inverters'), 'Alheio') returning id`,
    [`FRG-${randomBytes(3).toString("hex").toUpperCase()}`],
  );
  try {
    return await fn();
  } finally {
    await db().query(`delete from public.products where id = $1`, [rows[0].id]);
  }
}

let createdIdentity = false;

async function removeIdentity() {
  for (const user of (await readIdentity(admin)).users) {
    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(`cleanup failed: ${error.message}`);
  }
}

beforeAll(async () => {
  createdIdentity = (await readIdentity(admin)).users.length === 0;
  await provisionImportIdentity(admin);
});

afterAll(async () => {
  // Leave the identity exactly as found (it may be referenced by a local import).
  if (createdIdentity) await removeIdentity();
  await closeDb();
});

describe("first and second apply (same transaction, rolled back)", () => {
  it("synthetic plan: #1 creates everything, #2 only already_present, no duplicates", async () => {
    const plan = syntheticPlan();
    await withTransaction(async (client) => {
      const first = await importPlan(client, plan, SCOPED);
      expect(first.records).toMatchObject({ total: 9, created: 9, alreadyPresent: 0 });
      const second = await importPlan(client, plan, SCOPED);
      expect(second.records).toMatchObject({ total: 9, created: 0, alreadyPresent: 9 });
      expect(second.batchId).not.toBe(first.batchId);
      expect(second.executedBy).toBe(first.executedBy);

      const codes = plan.products.map((p) => p.code);
      const { rows } = await client.query<{ products: number; movements: number }>(
        `select (select count(*)::int from public.products where code = any($1)) as products,
                (select count(*)::int from public.stock_movements m join public.products p on p.id = m.product_id where p.code = any($1)) as movements`,
        [codes],
      );
      expect(rows[0]).toEqual({ products: 3, movements: 3 });
      const batches = await client.query<{ id: string; created: number; already: number; total: number }>(
        `select b.id, (b.summary->>'recordsCreated')::int as created, (b.summary->>'recordsAlreadyPresent')::int as already,
                (select count(*)::int from public.import_records r where r.batch_id = b.id) as total
           from public.import_batches b where b.id = any($1::uuid[]) order by created desc`,
        [[first.batchId, second.batchId]],
      );
      expect(batches.rows.map((b) => [b.created, b.already, b.total])).toEqual([
        [9, 0, 9],
        [0, 9, 9],
      ]);
    });
  });

  it("demo workbook: 35 records per batch, 345 units, 2/3/7, category totals, no negative balance", async () => {
    const plan = canonicalPlan();
    expect(plan.records).toHaveLength(5 + 3 + 12 + 10 + 5);
    await withTransaction(async (client) => {
      const options: ImportOptions = { policy: "scoped", expectations: CANONICAL_DB_EXPECTATIONS };
      const first = await importPlan(client, plan, options);
      expect(first.records.total).toBe(35);
      expect(first.records.created + first.records.alreadyPresent).toBe(35);
      expect(first.summary).toMatchObject({
        categories: 5,
        locations: 3,
        products: 12,
        openingBalances: 10,
        openingQuantity: 343,
        historicalMovements: 5,
        historicalNet: 2,
        finalQuantity: 345,
        statusCounts: { OUT_OF_STOCK: 2, REORDER: 3, OK: 7 },
        finalByCategory: CANONICAL_DB_EXPECTATIONS.finalByCategory,
        recordsTotal: 35,
      });

      const second = await importPlan(client, plan, options);
      expect(second.records).toMatchObject({ total: 35, created: 0, alreadyPresent: 35 });
      expect(second.summary).toMatchObject({ recordsCreated: 0, recordsAlreadyPresent: 35, finalQuantity: 345 });

      // Ledger rows carry the technical identity; every movement type of the plan is present.
      const codes = plan.products.map((p) => p.code);
      const { rows } = await client.query<{ type: string; n: number; qty: number; users: number }>(
        `select m.type::text as type, count(*)::int as n, sum(m.quantity)::int as qty, count(distinct m.user_id)::int as users
           from public.stock_movements m join public.products p on p.id = m.product_id
          where p.code = any($1) group by m.type order by m.type`,
        [codes],
      );
      // Enum order: OPENING_BALANCE, IN, OUT, ADJUSTMENT_IN, ADJUSTMENT_OUT.
      expect(rows.map((r) => [r.type, r.n, r.qty, r.users])).toEqual([
        ["OPENING_BALANCE", 10, 343, 1],
        ["IN", 2, 11, 1],
        ["OUT", 1, 12, 1],
        ["ADJUSTMENT_IN", 1, 5, 1],
        ["ADJUSTMENT_OUT", 1, 2, 1],
      ]);
      const user = await client.query(`select count(*)::int as n from public.stock_movements where user_id <> $1 and source_reference like 'tralyn-demo:%'`, [
        first.executedBy,
      ]);
      expect(user.rows[0].n).toBe(0);
      const receipt = await client.query<{ type: string; quantity: number; created_at: Date; source_reference: string; notes: string }>(
        `select m.type::text as type, m.quantity, m.created_at, m.source_reference, m.notes
           from public.stock_movements m join public.products p on p.id = m.product_id where p.code = 'INV-201'`,
      );
      expect(receipt.rows).toEqual([
        {
          type: "IN",
          quantity: 5,
          created_at: new Date("2026-04-14T23:00:00Z"),
          source_reference: plan.movements.find((m) => m.productCode === "INV-201")!.sourceReference,
          notes: "Demo stock receipt",
        },
      ]);
      const optional = await client.query(
        `select code, brand, model, qr_code, default_supplier_id from public.products where code in ('EVC-401','MNT-501') order by code`,
      );
      expect(optional.rows).toEqual([
        { code: "EVC-401", brand: "Northgrid", model: null, qr_code: null, default_supplier_id: null },
        { code: "MNT-501", brand: null, model: "Mounting Rail 4 m", qr_code: null, default_supplier_id: null },
      ]);
      const stock = await client.query<{ status: string; n: number; min: number }>(
        `select status::text as status, count(*)::int as n, min(balance)::int as min from public.product_stock where code = any($1) group by status order by status`,
        [codes],
      );
      expect(Object.fromEntries(stock.rows.map((r) => [r.status, r.n]))).toEqual({ OUT_OF_STOCK: 2, REORDER: 3, OK: 7 });
      expect(Math.min(...stock.rows.map((r) => r.min))).toBe(0);
      const records = await client.query<{ entity_type: string; n: number }>(
        `select entity_type, count(*)::int as n from public.import_records where batch_id = $1 group by entity_type order by entity_type`,
        [second.batchId],
      );
      expect(Object.fromEntries(records.rows.map((r) => [r.entity_type, r.n]))).toEqual({ category: 5, location: 3, product: 12, stock_movement: 15 });
      const batch = await client.query(`select source_file, source_sha256, import_version, executed_by from public.import_batches where id = $1`, [first.batchId]);
      expect(batch.rows[0]).toEqual({
        source_file: "tralyn-demo.xlsx",
        source_sha256: CANONICAL_EXPECTATIONS.sha256,
        import_version: "tralyn-demo-v1",
        executed_by: first.executedBy,
      });
      const example = await client.query(`select count(*)::int as n from public.import_records where batch_id = $1 and source_reference like '%Z-99-99%'`, [first.batchId]);
      expect(example.rows[0].n).toBe(0);
    });
  });
});

describe("divergent data aborts (never overwritten)", () => {
  it.each<[string, (plan: ImportPlan) => void, RegExp]>([
    ["product natural key with different attributes", (plan) => (plan.products[0].brand = "Outra marca"), /produtos.*divergentes \(brand\)/],
    ["movement source_reference with different data", (plan) => (plan.movements.find((m) => m.kind === "historical")!.quantity = 2), /movimentos.*divergentes \(quantity\)/],
    ["category with different description", (plan) => (plan.categories[0].description = "Outra"), /categorias.*divergentes \(description\)/],
    ["location with different description", (plan) => (plan.locations[0].description = "Outra"), /localizações.*divergentes \(description\)/],
  ])("%s", async (_label, mutate, expected) => {
    const plan = syntheticPlan();
    await withTransaction(async (client) => {
      await importPlan(client, plan, SCOPED);
      const divergent = structuredClone(plan);
      mutate(divergent);
      const error = await inSavepoint(client, () => importPlan(client, divergent, SCOPED).catch((e: unknown) => e));
      expect(error).toBeInstanceOf(ImportAbortedError);
      expect((error as Error).message).toMatch(expected);
    });
  });
});

describe("technical identity", () => {
  it("divergent identity (active = true) aborts before any write", async () => {
    const plan = syntheticPlan();
    await withTransaction(async (client) => {
      await client.query(`update public.profiles set active = true where id = (select id from auth.users where email = 'importacao@tralyn.invalid')`);
      const before = await client.query(`select count(*)::int as n from public.categories`);
      await expect(importPlan(client, plan, SCOPED)).rejects.toThrow(/identidade técnica.*active/);
      expect((await client.query(`select count(*)::int as n from public.categories`)).rows).toEqual(before.rows);
    });
  });

  it("missing identity aborts", async () => {
    const plan = syntheticPlan();
    await withTransaction(async (client) => {
      // Hide the identity inside the rolled-back transaction (e-mail changed, then restored by ROLLBACK).
      await client.query(`update auth.users set email = 'outro@example.invalid' where email = 'importacao@tralyn.invalid'`);
      await expect(importPlan(client, plan, SCOPED)).rejects.toThrow(/identidade técnica inexistente/);
    });
    expect((await readIdentity(admin)).users).toHaveLength(1);
  });
});

describe("transaction, dry-run and policy", () => {
  it("dry-run executes the whole flow and persists nothing", async () => {
    const before = await tableCounts();
    const outcome = await runImport(DB_URL, syntheticPlan(), "dry-run", SCOPED);
    expect(outcome).toMatchObject({ committed: false, records: { created: 9, alreadyPresent: 0 } });
    expect(await tableCounts()).toEqual(before);
    const batch = await db().query(`select count(*)::int as n from public.import_batches where id = $1`, [outcome.batchId]);
    expect(batch.rows[0].n).toBe(0);
  });

  it("failure after partial writes → complete rollback (apply mode)", async () => {
    const plan = syntheticPlan();
    const last = plan.products.at(-1)!;
    // A pre-existing, different product with the same code as the LAST planned product:
    // categories, the location and the first products are written before the abort.
    const { rows } = await db().query<{ id: string }>(
      `insert into public.products (code, category_id, model) values ($1, (select id from public.categories where name = 'Inverters'), 'Outro') returning id`,
      [last.code],
    );
    try {
      const before = await tableCounts();
      await expect(runImport(DB_URL, plan, "apply", SCOPED)).rejects.toThrow(/produtos/);
      expect(await tableCounts()).toEqual(before);
      const leftovers = await db().query(
        `select (select count(*)::int from public.categories where prefix = any($1)) as categories,
                (select count(*)::int from public.locations where code = any($2)) as locations`,
        [plan.categories.map((c) => c.prefix), plan.locations.map((l) => l.code)],
      );
      expect(leftovers.rows[0]).toEqual({ categories: 0, locations: 0 });
    } finally {
      await db().query(`delete from public.products where id = $1`, [rows[0].id]);
    }
  });

  it("pristine policy refuses a target with foreign data and writes nothing", async () => {
    await withForeignProduct(async () => {
      const before = await tableCounts();
      await expect(runImport(DB_URL, syntheticPlan(), "dry-run", { policy: "pristine" })).rejects.toThrow(/preflight.*products: \d+ registo/);
      expect(await tableCounts()).toEqual(before);
    });
  });

  it("advisory lock serializes concurrent imports", async () => {
    const plan = syntheticPlan();
    const a = new pg.Client({ connectionString: DB_URL });
    const b = new pg.Client({ connectionString: DB_URL });
    await Promise.all([a.connect(), b.connect()]);
    try {
      await a.query("begin");
      await b.query("begin");
      await importPlan(a, plan, SCOPED); // holds the transaction-scoped lock
      let settled = false;
      const second = importPlan(b, plan, SCOPED).finally(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);
      const waiting = await db().query(`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`);
      expect(waiting.rows[0].n).toBeGreaterThanOrEqual(1);

      await a.query("rollback"); // lock released only at transaction end
      const outcome = await second;
      expect(outcome.records.created).toBe(9); // A rolled back, so B created everything
      await b.query("rollback");
      const held = await db().query(`select count(*)::int as n from pg_locks where locktype = 'advisory'`);
      expect(held.rows[0].n).toBe(0); // no session lock survives
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      await Promise.all([a.end(), b.end()]);
    }
  });
});

describe("CLI (local only, never prints secrets)", () => {
  const cli = (args: string[], env: Record<string, string | undefined>) => {
    const childEnv = { ...process.env, ...env };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    return spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/inventory-import-local.ts", ...args], {
      encoding: "utf8",
      env: childEnv,
      timeout: 120_000,
    });
  };
  const file = `--file=${canonicalPath}`;

  it.each([
    ["hosted Supabase", "postgresql://postgres:TopSecret1@db.testprojectrefabcdef.supabase.co:5432/postgres"],
    ["remote IP", "postgresql://postgres:TopSecret1@10.1.2.3:5432/postgres"],
    ["invalid string", "TopSecret1"],
    ["missing", undefined],
  ])("refuses %s (exit 2, nothing echoed)", (_label, url) => {
    const run = cli(["--dry-run", file], { INVENTORY_IMPORT_DATABASE_URL: url });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/RECUSADO/);
    expect(run.stdout + run.stderr).not.toContain("TopSecret1");
  });

  it("apply without the exact SHA confirmation → exit 2", () => {
    const run = cli(["--apply", file, "--confirm-sha256=abc"], { INVENTORY_IMPORT_DATABASE_URL: DB_URL });
    expect(run.status).toBe(2);
  });

  it("usage errors → exit 2", () => {
    expect(cli([file], { INVENTORY_IMPORT_DATABASE_URL: DB_URL }).status).toBe(2);
    expect(cli(["--dry-run", "--apply", file], { INVENTORY_IMPORT_DATABASE_URL: DB_URL }).status).toBe(2);
    expect(cli(["--dry-run", file, "--force"], { INVENTORY_IMPORT_DATABASE_URL: DB_URL }).status).toBe(2);
  });

  it("dry-run on a target with foreign data is refused by the pristine preflight; nothing persisted or printed", async () => {
    await withForeignProduct(async () => {
      const before = await tableCounts();
      const run = cli(["--dry-run", file], { INVENTORY_IMPORT_DATABASE_URL: DB_URL });
      expect(run.status).toBe(1);
      expect(run.stderr).toMatch(/ABORTADO \(rollback\).*preflight/);
      expect(run.stdout + run.stderr).not.toContain(DB_URL);
      expect(run.stdout + run.stderr).not.toContain(new URL(DB_URL).password ? `:${new URL(DB_URL).password}@` : "@@");
      expect(await tableCounts()).toEqual(before);
    });
  });
});

