/**
 * IMPORT PLAN → PostgreSQL, in ONE transaction:
 *
 *   BEGIN → advisory xact lock → technical identity → preflight
 *         → categories → location → products → opening balances
 *         → historical movement → reconciliation → import_batch (final,
 *           immutable summary) → import_records → record check
 *   COMMIT (apply) | ROLLBACK (dry-run or any failure)
 *
 * The batch row is inserted after the entities because import_batches is
 * immutable (no later UPDATE of the summary) and the summary must describe
 * the verified result. Everything is in the same transaction, so the order is
 * not observable from outside.
 *
 * Existing rows are never updated: absent → INSERT ("created"), identical →
 * "already_present", different → abort (ROLLBACK). Ledger rows go through
 * the normal INSERT path, so every existing trigger/constraint applies.
 */
import pg from "pg";
import { IMPORT_IDENTITY, identityProblems, type IdentitySnapshot } from "../import-identity/identity";
import type { ImportEntityType, ImportPlan, PlannedRecord } from "./model";

type Db = pg.ClientBase;
type Action = "created" | "already_present";
type StockStatus = "OUT_OF_STOCK" | "REORDER" | "OK";

/**
 * Stable signed 64-bit key (not derived from any input). Fixed literal: it was
 * originally the first 8 bytes of a SHA-256 of a constant label, and must
 * never change, or an older and a newer importer could run concurrently.
 */
export const ADVISORY_LOCK_KEY = "1715638129914392095";

/**
 * pristine: the target may contain only this import's entities (and nothing
 *           else in suppliers/projects); global totals are reconciled. The CLI
 *           always uses it.
 * scoped:   only the plan's own entities are checked (used by tests that run
 *           inside a rolled-back transaction on the shared local test DB).
 */
export type TargetPolicy = "pristine" | "scoped";

export interface DbExpectations {
  statusCounts?: Record<StockStatus, number>;
  finalByCategory?: Record<string, number>;
}

/** Canonical database state after importing the demo workbook. */
export const CANONICAL_DB_EXPECTATIONS: DbExpectations = {
  statusCounts: { OUT_OF_STOCK: 2, REORDER: 3, OK: 7 },
  finalByCategory: {
    "Solar Panels": 48,
    Inverters: 8,
    Batteries: 14,
    "EV Chargers": 7,
    "Mounting & Protection": 268,
  },
};

export class ImportAbortedError extends Error {
  constructor(
    readonly stage: string,
    readonly problems: string[],
  ) {
    super(`Importação abortada (${stage}): ${problems.join("; ")}`);
    this.name = "ImportAbortedError";
  }
}

export interface ImportOptions {
  policy: TargetPolicy;
  expectations?: DbExpectations;
  now?: Date;
}

export interface ImportOutcome {
  batchId: string;
  importedAt: string;
  executedBy: string;
  records: { total: number; created: number; alreadyPresent: number; byEntity: Record<ImportEntityType, Record<Action, number>> };
  summary: Record<string, unknown>;
}

const abort = (stage: string, problems: string[]): never => {
  throw new ImportAbortedError(stage, problems);
};

const sameTime = (a: Date | string | null, b: string | null) =>
  a === null || b === null ? a === b : new Date(a).getTime() === new Date(b).getTime();

/** Lists the fields whose values differ (field names only). */
function differences(actual: Record<string, unknown>, expected: Record<string, unknown>): string[] {
  return Object.keys(expected).filter((key) => {
    const a = actual[key];
    const e = expected[key];
    if (key === "created_at") return !sameTime(a as Date | string | null, e as string | null);
    return a !== e;
  });
}

// -----------------------------------------------------------------------------
// Technical identity
// -----------------------------------------------------------------------------
/**
 * Validates the technical identity and returns its id. `lockProfile` (default)
 * holds the profile FOR SHARE until the transaction ends; read-only checks
 * pass false (row locks are not allowed in a READ ONLY transaction).
 */
export async function resolveImportIdentity(db: Db, now: Date, { lockProfile = true }: { lockProfile?: boolean } = {}): Promise<string> {
  const users = await db.query<{
    id: string;
    email: string | null;
    email_confirmed_at: Date | null;
    banned_until: Date | null;
    last_sign_in_at: Date | null;
    deleted_at: Date | null;
    is_anonymous: boolean;
    raw_app_meta_data: Record<string, unknown> | null;
  }>(
    `select id, email, email_confirmed_at, banned_until, last_sign_in_at, deleted_at, is_anonymous, raw_app_meta_data
       from auth.users where lower(email) = lower($1)`,
    [IMPORT_IDENTITY.email],
  );
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  // FOR SHARE: the profile cannot be changed (e.g. activated) until this transaction ends.
  const profiles = await db.query<{ id: string; name: string; role: string; active: boolean }>(
    `select id, name, role::text as role, active from public.profiles where id = any($1::uuid[])${lockProfile ? " for share" : ""}`,
    [users.rows.map((u) => u.id)],
  );
  const snapshot: IdentitySnapshot = {
    users: users.rows.map((u) => ({
      id: u.id,
      email: u.email,
      emailConfirmedAt: iso(u.email_confirmed_at),
      bannedUntil: iso(u.banned_until),
      lastSignInAt: iso(u.last_sign_in_at),
      deletedAt: iso(u.deleted_at),
      isAnonymous: u.is_anonymous,
      appMetadata: u.raw_app_meta_data ?? {},
    })),
    profile: users.rows.length === 1 ? (profiles.rows.find((p) => p.id === users.rows[0].id) ?? null) : null,
  };
  if (snapshot.users.length === 0) abort("identidade técnica", ["identidade técnica inexistente (provisione-a antes de importar)"]);
  const problems = identityProblems(snapshot, now);
  if (problems.length > 0) abort("identidade técnica", problems);
  return snapshot.users[0].id;
}

// -----------------------------------------------------------------------------
// Preflight
// -----------------------------------------------------------------------------
async function preflight(db: Db, plan: ImportPlan, policy: TargetPolicy) {
  const problems: string[] = [];
  const productCodes = plan.products.map((p) => p.code);
  const movementRefs = plan.movements.map((m) => m.sourceReference);

  // Always: plan products that already exist must not carry foreign movements.
  const foreign = await db.query<{ code: string }>(
    `select distinct p.code from public.stock_movements m join public.products p on p.id = m.product_id
      where lower(p.code) = any($1::text[]) and (m.source_reference is null or m.source_reference <> all($2::text[]))`,
    [productCodes.map((c) => c.toLowerCase()), movementRefs],
  );
  for (const row of foreign.rows) problems.push(`produto ${row.code} já tem movimentos fora desta importação`);

  if (policy === "pristine") {
    const { rows } = await db.query<Record<string, number>>(
      `select
         (select count(*)::int from public.categories where prefix <> all($1::text[])) as categories,
         (select count(*)::int from public.locations where code <> all($2::text[])) as locations,
         (select count(*)::int from public.products where code <> all($3::text[])) as products,
         (select count(*)::int from public.stock_movements where source_reference is null or source_reference <> all($4::text[])) as stock_movements,
         (select count(*)::int from public.suppliers) as suppliers,
         (select count(*)::int from public.projects) as projects`,
      [plan.categories.map((c) => c.prefix), plan.locations.map((l) => l.code), productCodes, movementRefs],
    );
    for (const [table, count] of Object.entries(rows[0])) {
      if (count !== 0) problems.push(`${table}: ${count} registo(s) que não pertencem a esta importação`);
    }
  }
  if (problems.length > 0) abort("preflight", problems);
}

// -----------------------------------------------------------------------------
// Entities (insert or prove identical; never update)
// -----------------------------------------------------------------------------
async function ensureCategory(db: Db, c: ImportPlan["categories"][number]): Promise<[string, Action]> {
  const { rows } = await db.query(
    `select id, name, prefix, description, active from public.categories where prefix = $1 or lower(name) = lower($2)`,
    [c.prefix, c.name],
  );
  if (rows.length === 0) {
    const inserted = await db.query<{ id: string }>(
      `insert into public.categories (name, prefix, description) values ($1, $2, $3) returning id`,
      [c.name, c.prefix, c.description],
    );
    return [inserted.rows[0].id, "created"];
  }
  const diff = rows.length === 1 ? differences(rows[0], { name: c.name, prefix: c.prefix, description: c.description, active: true }) : ["natural key"];
  if (diff.length > 0) abort("categorias", [`categoria ${c.prefix} existe com valores divergentes (${diff.join(", ")})`]);
  return [rows[0].id, "already_present"];
}

async function ensureLocation(db: Db, l: ImportPlan["locations"][number]): Promise<[string, Action]> {
  const { rows } = await db.query(
    `select id, code, zone, shelf, position, description, active from public.locations where lower(code) = lower($1)`,
    [l.code],
  );
  if (rows.length === 0) {
    const inserted = await db.query<{ id: string }>(
      `insert into public.locations (code, zone, shelf, position, description) values ($1, $2, $3, $4, $5) returning id`,
      [l.code, l.zone, l.shelf, l.position, l.description],
    );
    return [inserted.rows[0].id, "created"];
  }
  const diff = differences(rows[0], { code: l.code, zone: l.zone, shelf: l.shelf, position: l.position, description: l.description, active: true });
  if (diff.length > 0) abort("localizações", [`localização ${l.code} existe com valores divergentes (${diff.join(", ")})`]);
  return [rows[0].id, "already_present"];
}

async function ensureProduct(
  db: Db,
  p: ImportPlan["products"][number],
  categoryId: string,
  locationId: string,
): Promise<[string, Action]> {
  const expected = {
    code: p.code,
    category_id: categoryId,
    brand: p.brand,
    model: p.model,
    specification: p.specification,
    unit: p.unit,
    minimum_stock: p.minimumStock,
    location_id: locationId,
    default_supplier_id: null,
    qr_code: null,
    active: p.active,
    created_at: p.createdAt,
  };
  const { rows } = await db.query(
    `select id, code, category_id, brand, model, specification, unit, minimum_stock, location_id, default_supplier_id, qr_code, active, created_at
       from public.products where lower(code) = lower($1)`,
    [p.code],
  );
  if (rows.length === 0) {
    const inserted = await db.query<{ id: string }>(
      `insert into public.products
         (code, category_id, brand, model, specification, unit, minimum_stock, location_id, default_supplier_id, qr_code, active, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, null, null, $9, $10) returning id`,
      [p.code, categoryId, p.brand, p.model, p.specification, p.unit, p.minimumStock, locationId, p.active, p.createdAt],
    );
    return [inserted.rows[0].id, "created"];
  }
  const diff = differences(rows[0], expected);
  if (diff.length > 0) abort("produtos", [`produto ${p.code} existe com valores divergentes (${diff.join(", ")})`]);
  return [rows[0].id, "already_present"];
}

async function ensureMovement(db: Db, m: ImportPlan["movements"][number], productId: string, userId: string): Promise<[string, Action]> {
  const expected = {
    product_id: productId,
    type: m.type,
    quantity: m.quantity,
    project_id: null,
    user_id: userId,
    document_reference: m.documentReference,
    notes: m.notes,
    created_at: m.createdAt,
  };
  const { rows } = await db.query(
    `select id, product_id, type::text as type, quantity, project_id, user_id, document_reference, notes, created_at
       from public.stock_movements where source_reference = $1`,
    [m.sourceReference],
  );
  if (rows.length === 0) {
    const inserted = await db.query<{ id: string }>(
      `insert into public.stock_movements (product_id, type, quantity, user_id, document_reference, notes, source_reference, created_at)
       values ($1, $2::public.movement_type, $3, $4, $5, $6, $7, $8) returning id`,
      [productId, m.type, m.quantity, userId, m.documentReference, m.notes, m.sourceReference, m.createdAt],
    );
    return [inserted.rows[0].id, "created"];
  }
  const diff = differences(rows[0], expected);
  if (diff.length > 0) abort("movimentos", [`movimento ${m.sourceReference} existe com valores divergentes (${diff.join(", ")})`]);
  return [rows[0].id, "already_present"];
}

// -----------------------------------------------------------------------------
// Reconciliation (inside the transaction, before the batch is written)
// -----------------------------------------------------------------------------
export function expectedProductState(plan: ImportPlan) {
  const balance = new Map<string, number>(plan.products.map((p) => [p.code, 0]));
  for (const m of plan.movements) balance.set(m.productCode, balance.get(m.productCode)! + (m.type === "OUT" || m.type === "ADJUSTMENT_OUT" ? -m.quantity : m.quantity));
  return plan.products.map((p) => {
    const b = balance.get(p.code)!;
    const status: StockStatus = b <= 0 ? "OUT_OF_STOCK" : b <= p.minimumStock ? "REORDER" : "OK";
    return { code: p.code, balance: b, status };
  });
}

async function reconcile(db: Db, plan: ImportPlan, productIds: Map<string, string>, policy: TargetPolicy, expectations: DbExpectations = {}) {
  const problems: string[] = [];
  const ids = [...productIds.values()];
  const expectedState = expectedProductState(plan);

  const stock = await db.query<{ id: string; code: string; category_name: string; balance: number; status: StockStatus }>(
    `select id, code, category_name, balance, status::text as status from public.product_stock where id = any($1::uuid[])`,
    [ids],
  );
  if (stock.rows.length !== plan.products.length) problems.push(`product_stock tem ${stock.rows.length} dos ${plan.products.length} produtos`);
  for (const e of expectedState) {
    const row = stock.rows.find((r) => r.code === e.code);
    if (row && (row.balance !== e.balance || row.status !== e.status)) problems.push(`${e.code}: saldo/estado ${row.balance}/${row.status} ≠ ${e.balance}/${e.status}`);
  }

  const movements = await db.query<{ type: string; n: number; qty: number }>(
    `select type::text as type, count(*)::int as n, sum(quantity)::int as qty from public.stock_movements
      where product_id = any($1::uuid[]) group by type order by type`,
    [ids],
  );
  const byType = Object.fromEntries(movements.rows.map((r) => [r.type, r]));
  const openings = plan.movements.filter((m) => m.kind === "opening");
  const planCount = (type: string) => plan.movements.filter((m) => m.type === type).length;
  if ((byType.OPENING_BALANCE?.n ?? 0) !== openings.length) problems.push(`OPENING_BALANCE = ${byType.OPENING_BALANCE?.n ?? 0}, esperado ${openings.length}`);
  if ((byType.OPENING_BALANCE?.qty ?? 0) !== plan.reconciliation.openingQuantity) {
    problems.push(`soma OPENING_BALANCE = ${byType.OPENING_BALANCE?.qty ?? 0}, esperado ${plan.reconciliation.openingQuantity}`);
  }
  for (const type of ["IN", "OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"]) {
    if ((byType[type]?.n ?? 0) !== planCount(type)) problems.push(`${type} = ${byType[type]?.n ?? 0}, esperado ${planCount(type)}`);
  }

  const finalQuantity = stock.rows.reduce((s, r) => s + r.balance, 0);
  if (finalQuantity !== plan.reconciliation.finalQuantity) problems.push(`estoque total = ${finalQuantity}, esperado ${plan.reconciliation.finalQuantity}`);
  const statusCounts: Record<StockStatus, number> = { OUT_OF_STOCK: 0, REORDER: 0, OK: 0 };
  for (const r of stock.rows) statusCounts[r.status] += 1;
  const finalByCategory: Record<string, number> = {};
  for (const r of stock.rows) finalByCategory[r.category_name] = (finalByCategory[r.category_name] ?? 0) + r.balance;
  for (const c of plan.reconciliation.byCategory) {
    if ((finalByCategory[c.name] ?? 0) !== c.final) problems.push(`categoria ${c.name} = ${finalByCategory[c.name] ?? 0}, esperado ${c.final}`);
  }
  if (expectations.statusCounts && JSON.stringify(statusCounts) !== JSON.stringify(expectations.statusCounts)) {
    problems.push(`estados ${JSON.stringify(statusCounts)} ≠ ${JSON.stringify(expectations.statusCounts)}`);
  }
  if (expectations.finalByCategory) {
    for (const [name, total] of Object.entries(expectations.finalByCategory)) {
      if (finalByCategory[name] !== total) problems.push(`total final ${name} = ${finalByCategory[name] ?? 0}, esperado ${total}`);
    }
  }

  let global: Record<string, number> | null = null;
  if (policy === "pristine") {
    const { rows } = await db.query<Record<string, number>>(
      `select (select count(*)::int from public.categories) as categories,
              (select count(*)::int from public.locations) as locations,
              (select count(*)::int from public.suppliers) as suppliers,
              (select count(*)::int from public.projects) as projects,
              (select count(*)::int from public.products) as products,
              (select count(*)::int from public.stock_movements) as stock_movements,
              (select count(*)::int from public.product_stock) as product_stock,
              (select coalesce(sum(balance), 0)::int from public.product_stock) as total_stock`,
    );
    global = rows[0];
    const wanted: Record<string, number> = {
      categories: plan.categories.length,
      locations: plan.locations.length,
      suppliers: 0,
      projects: 0,
      products: plan.products.length,
      stock_movements: plan.movements.length,
      product_stock: plan.products.length,
      total_stock: plan.reconciliation.finalQuantity,
    };
    for (const [key, value] of Object.entries(wanted)) {
      if (global[key] !== value) problems.push(`global ${key} = ${global[key]}, esperado ${value}`);
    }
  }

  if (problems.length > 0) abort("reconciliação", problems);
  return {
    categories: plan.categories.length,
    locations: plan.locations.length,
    products: stock.rows.length,
    openingBalances: byType.OPENING_BALANCE?.n ?? 0,
    openingQuantity: byType.OPENING_BALANCE?.qty ?? 0,
    historicalMovements: plan.movements.filter((m) => m.kind === "historical").length,
    historicalNet: finalQuantity - (byType.OPENING_BALANCE?.qty ?? 0),
    finalQuantity,
    statusCounts,
    finalByCategory,
    global,
  };
}

// -----------------------------------------------------------------------------
// Orchestration (caller owns BEGIN / COMMIT / ROLLBACK)
// -----------------------------------------------------------------------------
export async function importPlan(db: Db, plan: ImportPlan, options: ImportOptions): Promise<ImportOutcome> {
  const now = options.now ?? new Date();
  await db.query("select pg_advisory_xact_lock($1::bigint)", [ADVISORY_LOCK_KEY]);
  const userId = await resolveImportIdentity(db, now);
  await preflight(db, plan, options.policy);

  const entityIds = new Map<string, string>(); // `${entityType}|${sourceReference}` → id
  const actions = new Map<string, Action>();
  const remember = (type: ImportEntityType, ref: string, [id, action]: [string, Action]) => {
    entityIds.set(`${type}|${ref}`, id);
    actions.set(`${type}|${ref}`, action);
    return id;
  };

  const categoryIds = new Map<string, string>();
  for (const c of plan.categories) categoryIds.set(c.prefix, remember("category", c.sourceReference, await ensureCategory(db, c)));
  const locationIds = new Map<string, string>();
  for (const l of plan.locations) locationIds.set(l.code, remember("location", l.sourceReference, await ensureLocation(db, l)));
  const productIds = new Map<string, string>();
  for (const p of plan.products) {
    const id = await ensureProduct(db, p, categoryIds.get(p.categoryPrefix)!, locationIds.get(p.locationCode)!);
    productIds.set(p.code, remember("product", p.sourceReference, id));
  }
  for (const m of plan.movements) remember("stock_movement", m.sourceReference, await ensureMovement(db, m, productIds.get(m.productCode)!, userId));

  const reconciliation = await reconcile(db, plan, productIds, options.policy, options.expectations);

  const byEntity = {
    category: { created: 0, already_present: 0 },
    location: { created: 0, already_present: 0 },
    product: { created: 0, already_present: 0 },
    stock_movement: { created: 0, already_present: 0 },
  } satisfies Record<ImportEntityType, Record<Action, number>>;
  for (const r of plan.records) byEntity[r.entityType][actions.get(`${r.entityType}|${r.sourceReference}`)!] += 1;
  const created = Object.values(byEntity).reduce((s, e) => s + e.created, 0);
  const alreadyPresent = Object.values(byEntity).reduce((s, e) => s + e.already_present, 0);

  const summary = {
    importVersion: plan.source.importVersion,
    policy: options.policy,
    categories: reconciliation.categories,
    locations: reconciliation.locations,
    suppliers: 0,
    products: reconciliation.products,
    openingBalances: reconciliation.openingBalances,
    openingQuantity: reconciliation.openingQuantity,
    historicalMovements: reconciliation.historicalMovements,
    historicalNet: reconciliation.historicalNet,
    finalQuantity: reconciliation.finalQuantity,
    statusCounts: reconciliation.statusCounts,
    finalByCategory: reconciliation.finalByCategory,
    recordsTotal: plan.records.length,
    recordsCreated: created,
    recordsAlreadyPresent: alreadyPresent,
    byEntity,
  };

  const batch = await db.query<{ id: string; imported_at: Date }>(
    `insert into public.import_batches (source_file, source_sha256, import_version, executed_by, summary)
     values ($1, $2, $3, $4, $5::jsonb) returning id, imported_at`,
    [plan.source.fileName, plan.source.sha256, plan.source.importVersion, userId, JSON.stringify(summary)],
  );
  const batchId = batch.rows[0].id;

  const recordRows = plan.records.map((r: PlannedRecord) => ({
    entity_type: r.entityType,
    entity_id: entityIds.get(`${r.entityType}|${r.sourceReference}`)!,
    source_reference: r.sourceReference,
    source_sheet: r.sourceSheet,
    source_row: r.sourceRow,
    action: actions.get(`${r.entityType}|${r.sourceReference}`)!,
    source_data: r.sourceData,
  }));
  await db.query(
    `insert into public.import_records (batch_id, entity_type, entity_id, source_reference, source_sheet, source_row, action, source_data)
     select $1, x.entity_type, x.entity_id, x.source_reference, x.source_sheet, x.source_row, x.action, x.source_data
       from jsonb_to_recordset($2::jsonb) as x(entity_type text, entity_id uuid, source_reference text, source_sheet text,
                                               source_row integer, action text, source_data jsonb)`,
    [batchId, JSON.stringify(recordRows)],
  );

  const check = await db.query<{ action: Action; n: number }>(
    `select action, count(*)::int as n from public.import_records where batch_id = $1 group by action`,
    [batchId],
  );
  const counted = Object.fromEntries(check.rows.map((r) => [r.action, r.n]));
  if ((counted.created ?? 0) !== created || (counted.already_present ?? 0) !== alreadyPresent) {
    abort("import_records", [`registos ${JSON.stringify(counted)} ≠ resumo ${created}/${alreadyPresent}`]);
  }

  return {
    batchId,
    importedAt: batch.rows[0].imported_at.toISOString(),
    executedBy: userId,
    records: { total: plan.records.length, created, alreadyPresent, byEntity },
    summary,
  };
}

/** One connection, one transaction. dry-run always rolls back. */
export async function runImport(
  connectionString: string,
  plan: ImportPlan,
  mode: "dry-run" | "apply",
  options: ImportOptions,
): Promise<ImportOutcome & { committed: boolean }> {
  const client = new pg.Client({ connectionString, application_name: "tralyn-import" });
  await client.connect();
  try {
    await client.query("begin");
    try {
      const outcome = await importPlan(client, plan, options);
      if (mode === "apply") {
        await client.query("commit");
        return { ...outcome, committed: true };
      }
      await client.query("rollback");
      return { ...outcome, committed: false };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    await client.end();
  }
}
