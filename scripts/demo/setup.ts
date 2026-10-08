/**
 * LOCAL demo bootstrap (destructive for the LOCAL database only):
 *
 *   guard → `supabase db reset --local` (migrations + structural seed) → guard
 *   → technical import identity → demo users → canonical demo import
 *   (fixtures/tralyn-demo.xlsx, pristine) → suppliers / projects / supplier
 *   links (app services, RLS) → operational movements (RPC) → final project
 *   statuses → verify DEMO_VISUAL_STATE.
 *
 * Nothing here can target a hosted project: every step re-reads the local
 * stack and the guard refuses anything that is not loopback.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { createProject, setProjectStatus } from "@/services/master-data/projects";
import { createSupplier } from "@/services/master-data/suppliers";
import { registerMovement } from "@/services/movements";
import { updateProduct } from "@/services/products";
import type { Database } from "@/types/database";
import { projectSchema, supplierSchema } from "@/validation/master-data";
import { movementSchema } from "@/validation/movements";
import { productSchema } from "@/validation/products";
import { provisionImportIdentity } from "../import-identity/provision";
import { CANONICAL_WORKBOOK_PATH, CANONICAL_EXPECTATIONS } from "../inventory-import/expectations";
import { CANONICAL_DB_EXPECTATIONS, runImport } from "../inventory-import/importer";
import { buildImportPlan } from "../inventory-import/pipeline";
import { assertLocalDatabaseUrl } from "../inventory-import/target";
import { DEMO_OPERATIONS, DEMO_PASSWORD, DEMO_PROJECTS, DEMO_SUPPLIER_LINKS, DEMO_SUPPLIERS, DEMO_USERS, type DemoRole } from "./data";
import { demoTargetProblems, type DemoTargetFacts } from "./guard";
import { DEMO_VISUAL_STATE, type DemoState } from "./state";

type Client = SupabaseClient<Database>;

export class DemoSetupError extends Error {
  constructor(
    message: string,
    readonly problems: string[] = [],
  ) {
    super(problems.length > 0 ? `${message}: ${problems.join("; ")}` : message);
    this.name = "DemoSetupError";
  }
}

const SUPABASE_CLI = ["node_modules/supabase/dist/supabase.js"];

interface LocalStack {
  apiUrl: string;
  dbUrl: string;
  publishableKey: string;
  secretKey: string;
}

function readStatus(): Partial<LocalStack> {
  let raw: string;
  try {
    raw = execFileSync(process.execPath, [...SUPABASE_CLI, "status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return {};
  }
  try {
    const s = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
    return { apiUrl: s.API_URL, dbUrl: s.DB_URL, publishableKey: s.PUBLISHABLE_KEY, secretKey: s.SECRET_KEY };
  } catch {
    // Never surface the parser message: it could quote part of the output (keys).
    return {};
  }
}

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function collectTargetFacts(): DemoTargetFacts & Partial<LocalStack> {
  const config = readFileOrNull("supabase/config.toml");
  const projectId = config?.match(/^project_id\s*=\s*"([^"]*)"/m)?.[1] ?? null;
  const linkedRef = readFileOrNull("supabase/.temp/project-ref")?.trim() || null;
  return { env: process.env, projectId, linkedRef, ...readStatus() };
}

/** Re-reads every signal and refuses unless the target is the local `tralyn` stack. */
export async function assertDemoTarget(): Promise<LocalStack> {
  const facts = collectTargetFacts();
  const problems = demoTargetProblems(facts);
  if (problems.length > 0) throw new DemoSetupError("Alvo recusado (a demo só corre no Supabase local)", problems);
  // Second, independent check of the database URL (also resolves localhost to loopback only).
  await assertLocalDatabaseUrl(facts.dbUrl);
  if (!facts.publishableKey || !facts.secretKey) throw new DemoSetupError("Chaves locais indisponíveis em `supabase status`");
  return { apiUrl: facts.apiUrl!, dbUrl: facts.dbUrl!, publishableKey: facts.publishableKey, secretKey: facts.secretKey };
}

function resetLocalDatabase(): void {
  // Always --local (never --linked): migrations + supabase/seed.sql on the Docker stack.
  execFileSync(process.execPath, [...SUPABASE_CLI, "db", "reset", "--local"], { stdio: "ignore" });
}

/** After a reset the Auth and REST containers restart; wait until both answer (local URLs only). */
async function waitForServices(stack: LocalStack, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const endpoints = [`${stack.apiUrl}/auth/v1/health`, `${stack.apiUrl}/rest/v1/`];
  for (const url of endpoints) {
    for (;;) {
      try {
        const response = await fetch(url, { headers: { apikey: stack.publishableKey } });
        if (response.ok) break;
      } catch {
        // container still starting
      }
      if (Date.now() > deadline) throw new DemoSetupError("Serviços locais não ficaram disponíveis após o reset", [new URL(url).pathname]);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } };

function check<T extends { ok: boolean }>(result: T, what: string): T & { ok: true } {
  if (!result.ok) throw new DemoSetupError(`Falhou: ${what}`, ["message" in result ? String(result.message) : "erro"]);
  return result as T & { ok: true };
}

async function createDemoUsers(admin: Client): Promise<void> {
  for (const user of DEMO_USERS) {
    const { data, error } = await admin.auth.admin.createUser({
      email: user.email,
      password: DEMO_PASSWORD,
      email_confirm: true,
      user_metadata: { name: user.name },
    });
    if (error || !data.user) throw new DemoSetupError(`Falhou a criação de ${user.email}`, [error?.code ?? "sem utilizador"]);
    // Bootstrap only: the first admin cannot be promoted by another admin.
    const updated = await admin.from("profiles").update({ role: user.role, active: true }).eq("id", data.user.id).select("id").single();
    if (updated.error) throw new DemoSetupError(`Falhou o perfil de ${user.email}`, [updated.error.code]);
  }
}

async function signIn(stack: LocalStack, role: DemoRole): Promise<Client> {
  const user = DEMO_USERS.find((u) => u.key === role)!;
  const client = createClient<Database>(stack.apiUrl, stack.publishableKey, clientOptions);
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: DEMO_PASSWORD });
  if (error) throw new DemoSetupError(`Falhou o início de sessão de ${user.email}`, [error.code ?? "auth"]);
  return client;
}

async function productIdsByCode(client: Client): Promise<Map<string, string>> {
  const { data, error } = await client.from("products").select("id, code");
  if (error) throw new DemoSetupError("Falhou a leitura de produtos", [error.code]);
  return new Map(data.map((p) => [p.code, p.id]));
}

async function linkSuppliers(admin: Client, supplierIds: Map<string, string>, productIds: Map<string, string>): Promise<void> {
  for (const [code, supplierName] of Object.entries(DEMO_SUPPLIER_LINKS)) {
    const id = productIds.get(code)!;
    const { data: p, error } = await admin
      .from("products")
      .select("code, category_id, brand, model, specification, unit, minimum_stock, location_id")
      .eq("id", id)
      .single();
    if (error) throw new DemoSetupError(`Falhou a leitura de ${code}`, [error.code]);
    const input = productSchema.parse({ ...p, minimum_stock: String(p.minimum_stock), default_supplier_id: supplierIds.get(supplierName) });
    check(await updateProduct(admin, id, input), `fornecedor de ${code}`);
  }
}

export interface DemoSetupReport {
  canonicalImport: { records: number; created: number; finalQuantity: unknown; statusCounts: unknown };
  state: DemoState;
}

export async function runDemoSetup(): Promise<DemoSetupReport> {
  await assertDemoTarget();
  resetLocalDatabase();
  const stack = await assertDemoTarget();
  await waitForServices(stack);

  const admin = createClient<Database>(stack.apiUrl, stack.secretKey, clientOptions);
  await provisionImportIdentity(admin);
  await createDemoUsers(admin);

  // Canonical demo import: same pipeline and pristine policy as any first import.
  const plan = buildImportPlan({ fileName: CANONICAL_EXPECTATIONS.fileName, bytes: readFileSync(CANONICAL_WORKBOOK_PATH) });
  if (!plan.ok) throw new DemoSetupError("Workbook demo inválido", plan.errors.map((e) => e.code));
  const imported = await runImport(stack.dbUrl, plan.plan, "apply", { policy: "pristine", expectations: CANONICAL_DB_EXPECTATIONS });
  const canonicalState = await measureDemoState(stack.dbUrl);

  // Everything below goes through the application's services under RLS.
  const adminUser = await signIn(stack, "admin");
  const operator = await signIn(stack, "operator");
  const actors: Record<Exclude<DemoRole, "viewer">, Client> = { admin: adminUser, operator };

  const supplierIds = new Map<string, string>();
  for (const s of DEMO_SUPPLIERS) supplierIds.set(s.name, check(await createSupplier(adminUser, supplierSchema.parse(s)), s.name).id);

  const projectIds = new Map<string, string>();
  for (const p of DEMO_PROJECTS) {
    const input = projectSchema.parse({ name: p.name, client: p.client, reference: p.reference, notes: p.notes, status: "active" });
    projectIds.set(p.name, check(await createProject(adminUser, input), p.name).id);
  }

  const productIds = await productIdsByCode(adminUser);
  await linkSuppliers(adminUser, supplierIds, productIds);

  for (const op of DEMO_OPERATIONS) {
    const input = movementSchema.parse({
      product_id: productIds.get(op.code),
      type: op.type,
      quantity: String(op.quantity),
      project_id: op.project ? projectIds.get(op.project) : null,
      document_reference: op.document,
      notes: op.notes,
    });
    check(await registerMovement(actors[op.actor], input), `${op.type} ${op.code}`);
  }

  for (const p of DEMO_PROJECTS) {
    if (p.finalStatus !== "active") check(await setProjectStatus(adminUser, projectIds.get(p.name)!, p.finalStatus), `estado de ${p.name}`);
  }
  await Promise.all([adminUser.auth.signOut(), operator.auth.signOut()]);

  const state = await measureDemoState(stack.dbUrl);
  const problems = demoStateProblems(state, DEMO_VISUAL_STATE);
  if (problems.length > 0) throw new DemoSetupError("Estado final da demo inesperado", problems);
  return {
    canonicalImport: {
      records: imported.records.total,
      created: imported.records.created,
      finalQuantity: canonicalState.totalStock,
      statusCounts: canonicalState.statusCounts,
    },
    state,
  };
}

/** Read-only measurement of the local demo database (counts, ledger and stock). */
export async function measureDemoState(dbUrl: string): Promise<DemoState> {
  const client = new pg.Client({ connectionString: dbUrl, application_name: "tralyn-demo-check" });
  await client.connect();
  try {
    const one = async <T>(sql: string) => (await client.query<{ v: T }>(sql)).rows[0].v;
    return {
      counts: await one(`select json_build_object(
          'categories', (select count(*)::int from public.categories),
          'locations', (select count(*)::int from public.locations),
          'suppliers', (select count(*)::int from public.suppliers),
          'projects', (select count(*)::int from public.projects),
          'products', (select count(*)::int from public.products),
          'productsWithSupplier', (select count(*)::int from public.products where default_supplier_id is not null),
          'stockMovements', (select count(*)::int from public.stock_movements),
          'projectMovements', (select count(*)::int from public.stock_movements where project_id is not null),
          'importBatches', (select count(*)::int from public.import_batches),
          'importRecords', (select count(*)::int from public.import_records)) as v`),
      projectsByStatus: await one(`select coalesce(json_object_agg(status, n order by status), '{}') as v
          from (select status::text, count(*)::int as n from public.projects group by status) s`),
      users: await one(`select coalesce(json_agg(json_build_object('email', u.email, 'name', p.name, 'role', p.role, 'active', p.active) order by u.email), '[]') as v
          from auth.users u join public.profiles p on p.id = u.id`),
      movementsByType: await one(`select coalesce(json_object_agg(type, json_build_object('count', n, 'quantity', q) order by type), '{}') as v
          from (select type::text, count(*)::int as n, sum(quantity)::int as q from public.stock_movements group by type) s`),
      movementsByUser: await one(`select coalesce(json_object_agg(name, n order by name), '{}') as v
          from (select p.name, count(*)::int as n from public.stock_movements m join public.profiles p on p.id = m.user_id group by p.name) s`),
      totalStock: await one(`select coalesce(sum(balance), 0)::int as v from public.product_stock`),
      statusCounts: await one(`select json_build_object(
          'OUT_OF_STOCK', count(*) filter (where status = 'OUT_OF_STOCK'),
          'REORDER', count(*) filter (where status = 'REORDER'),
          'OK', count(*) filter (where status = 'OK')) as v from public.product_stock`),
      balances: await one(`select coalesce(json_object_agg(code, balance order by code), '{}') as v from public.product_stock`),
      minBalance: await one(`select coalesce(min(balance), 0)::int as v from public.product_stock`),
    };
  } finally {
    await client.end();
  }
}

export function demoStateProblems(actual: DemoState, expected: DemoState): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(expected) as (keyof DemoState)[]) {
    if (JSON.stringify(sortKeys(actual[key])) !== JSON.stringify(sortKeys(expected[key]))) problems.push(`${key} difere`);
  }
  return problems;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}
