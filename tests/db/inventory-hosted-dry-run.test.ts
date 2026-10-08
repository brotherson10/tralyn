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
import { HostedDryRunError, runHostedDryRun, type HostedDryRunDeps, type TableCounts } from "../../scripts/inventory-import/hosted-dry-run";
import type { ImportPlan } from "../../scripts/inventory-import/model";
import { buildImportPlan } from "../../scripts/inventory-import/pipeline";
import { buildFixture, type FixtureSheets } from "../../scripts/inventory-import/test-fixture";
import { closeDb, createUser, db, localStack } from "./helpers";

/**
 * The hosted dry-run orchestration exercised ONLY against the LOCAL stack:
 * connections go to 127.0.0.1, the "linked CLI" facts are read from the local
 * database and the linked project is a test double. Nothing here reaches the
 * hosted project.
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
  const tag = `H${randomBytes(4).toString("hex").toUpperCase().slice(0, 5)}`;
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

async function counts(): Promise<TableCounts> {
  const { rows } = await db().query<{ c: TableCounts }>(
    `select json_build_object('auth_users', (select count(*)::int from auth.users), 'profiles', (select count(*)::int from public.profiles),
       'categories', (select count(*)::int from public.categories), 'locations', (select count(*)::int from public.locations),
       'suppliers', (select count(*)::int from public.suppliers), 'projects', (select count(*)::int from public.projects),
       'products', (select count(*)::int from public.products), 'stock_movements', (select count(*)::int from public.stock_movements),
       'import_batches', (select count(*)::int from public.import_batches), 'import_records', (select count(*)::int from public.import_records)) as c`,
  );
  return rows[0].c;
}

const canonicalLink = (): LinkedProjectFacts => ({
  linkedRefFile: PROJECT.ref,
  projects: [{ ref: PROJECT.ref, name: PROJECT.name, status: "ACTIVE_HEALTHY", linked: true }],
});
const readLocalFacts = async (): Promise<PreflightFacts> => (await db().query<{ facts: PreflightFacts }>(PREFLIGHT_SQL)).rows[0].facts;

let baseline: TableCounts;
let createdIdentity = false;
let connections = 0;

function deps(overrides: Partial<HostedDryRunDeps> = {}): HostedDryRunDeps {
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
    // Same rule as HOSTED_BASELINE (1/1 before the identity → 2/2 with it), relative to the local DB.
    identityBaseline: { authUsers: baseline.auth_users - 1, profiles: baseline.profiles - 1, emptyTables: [] },
    dataBaseline: baseline,
    importOptions: { policy: "scoped" },
    ...overrides,
  };
}

async function expectRefused(promise: Promise<unknown>, stage: string, connectionsUsed: number) {
  const before = connections;
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HostedDryRunError);
  expect((error as HostedDryRunError).stage).toBe(stage);
  expect(connections - before).toBe(connectionsUsed);
  expect(await counts()).toEqual(baseline);
  return error as HostedDryRunError;
}

beforeAll(async () => {
  createdIdentity = (await readIdentity(admin)).users.length === 0;
  await provisionImportIdentity(admin);
  // The "different database" case swaps every non-technical user id: make sure one exists
  // (a freshly reset database may hold only the technical identity).
  await createUser("viewer");
  baseline = await counts();
});

afterAll(async () => {
  if (createdIdentity) {
    for (const user of (await readIdentity(admin)).users) await admin.auth.admin.deleteUser(user.id);
  }
  await closeDb();
});

describe("hosted dry-run orchestration (local doubles)", () => {
  it("runs the full import inside the transaction, rolls back and proves nothing persisted", async () => {
    const plan = syntheticPlan();
    const before = connections;
    const report = await runHostedDryRun(plan, deps());
    expect(connections - before).toBe(3); // precheck, dry-run, postcheck (each a new connection)
    expect(report.rolledBack).toBe(true);
    expect(report.precheck).toEqual(baseline);
    expect(report.inTransaction.counts).toEqual({
      ...baseline,
      categories: baseline.categories + 2,
      locations: baseline.locations + 1,
      products: baseline.products + 3,
      stock_movements: baseline.stock_movements + 3,
      import_batches: baseline.import_batches + 1,
      import_records: baseline.import_records + 9,
    });
    expect(report.inTransaction.batchRecords).toEqual({ created: 9, already_present: 0 });
    expect(report.postcheck).toEqual({ counts: baseline, backToBaseline: true, identityUnchanged: true });
    expect(await counts()).toEqual(baseline);
  });

  it("wrong linked project → refused before any connection", async () => {
    await expectRefused(runHostedDryRun(syntheticPlan(), deps({ readLinkedProject: async () => ({ ...canonicalLink(), linkedRefFile: "otherprojectref" }) })), "projeto ligado", 0);
  });

  it("unhealthy linked project → refused before any connection", async () => {
    const link = canonicalLink();
    link.projects[0].status = "PAUSED";
    await expectRefused(runHostedDryRun(syntheticPlan(), deps({ readLinkedProject: async () => link })), "projeto ligado", 0);
  });

  it("identity missing/invalid through the CLI channel → refused before any connection", async () => {
    const readCliFacts = async () => ({ ...(await readLocalFacts()), identity_users: [] });
    await expectRefused(runHostedDryRun(syntheticPlan(), deps({ readCliFacts })), "identidade técnica (CLI)", 0);
  });

  it("pg connection on a different database than the linked project → refused at precheck, no write", async () => {
    const readCliFacts = async () => {
      const facts = await readLocalFacts();
      const technical = facts.identity_users[0].id;
      return { ...facts, auth_user_ids: facts.auth_user_ids.map((id) => (id === technical ? id : randomUUID())) };
    };
    await expectRefused(runHostedDryRun(syntheticPlan(), deps({ readCliFacts })), "binding", 1);
  });

  it("unexpected existing data (baseline differs) → refused at precheck, no write", async () => {
    await expectRefused(runHostedDryRun(syntheticPlan(), deps({ dataBaseline: { ...baseline, products: baseline.products + 1 } })), "pré-check", 1);
  });

  it("failure after BEGIN → rollback, read-only postcheck attached, nothing persisted", async () => {
    const error = await expectRefused(
      runHostedDryRun(syntheticPlan(), deps({ importOptions: { policy: "scoped", expectations: { statusCounts: { OUT_OF_STOCK: 9, REORDER: 9, OK: 9 } } } })),
      "dry-run",
      3,
    );
    expect(error.message).toMatch(/reconciliação/);
    expect(error.postcheck).toEqual({ counts: baseline, backToBaseline: true, identityUnchanged: true });
  });

  it("pristine policy on a target with foreign data → aborts inside the transaction, nothing persisted", async () => {
    const error = await expectRefused(runHostedDryRun(syntheticPlan(), deps({ importOptions: { policy: "pristine" } })), "dry-run", 3);
    expect(error.message).toMatch(/preflight/);
    expect(error.postcheck?.backToBaseline).toBe(true);
  });
});
