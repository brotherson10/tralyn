/**
 * HOSTED APPLY of the legacy inventory: the ONLY module allowed to persist.
 * It shares every step with the approved dry-run (hosted-session.ts) and adds
 * a pre-COMMIT gate with exact invariants plus a post-COMMIT verification.
 *
 *   prechecks (linked project, identity, read-only binding + pristine baseline)
 *   → BEGIN → importInSession() → measure() == invariants ? COMMIT : ROLLBACK
 *   → post-COMMIT measure() on a NEW read-only connection (+ identity unchanged)
 *
 * Failure semantics (never repaired automatically):
 *   before COMMIT       → ROLLBACK, read-only postcheck proves the baseline
 *   COMMIT fails        → outcome unknown, read-only state reported
 *   post-COMMIT differs → data persisted, reported for manual review
 */
import type pg from "pg";
import { expectedProductState } from "./importer";
import type { ImportPlan } from "./model";
import {
  HostedImportError,
  importInSession,
  postcheck,
  readOnly,
  refuse,
  runHostedPrechecks,
  snapshot,
  type HostedSessionDeps,
  type InTransactionResult,
  type PostcheckReport,
  type TableCounts,
} from "./hosted-session";

/** Explicit persistence confirmation (distinct from every dry-run argument). */
export const APPLY_CONFIRMATION = "IMPORT-345-UNITS";

type StockStatus = "OUT_OF_STOCK" | "REORDER" | "OK";

/** Global state of the target, measured inside the transaction and after COMMIT. */
export interface StateMeasurement {
  counts: TableCounts;
  movementsByType: Record<string, { count: number; quantity: number }>;
  productStock: number;
  totalStock: number;
  statusCounts: Record<StockStatus, number>;
  finalByCategory: Record<string, number>;
}

export interface ApplyInvariants extends StateMeasurement {
  batchRecords: { created: number; already_present: number };
  /** Movements recorded by this batch (all must belong to the technical identity). */
  batchMovements: number;
}

export interface BatchMeasurement {
  batchRecords: { created: number; already_present: number };
  batchMovements: number;
  movementsNotByIdentity: number;
  batchExecutedByIdentity: boolean;
}

/**
 * Exact state a pristine hosted project must reach after importing the demo
 * workbook (pristine baseline + the canonical plan; pinned by tests).
 */
export const CANONICAL_APPLY_INVARIANTS: ApplyInvariants = {
  counts: {
    auth_users: 2,
    profiles: 2,
    categories: 5,
    locations: 3,
    suppliers: 0,
    projects: 0,
    products: 12,
    stock_movements: 15,
    import_batches: 1,
    import_records: 35,
  },
  movementsByType: {
    OPENING_BALANCE: { count: 10, quantity: 343 },
    IN: { count: 2, quantity: 11 },
    OUT: { count: 1, quantity: 12 },
    ADJUSTMENT_IN: { count: 1, quantity: 5 },
    ADJUSTMENT_OUT: { count: 1, quantity: 2 },
  },
  productStock: 12,
  totalStock: 345,
  statusCounts: { OUT_OF_STOCK: 2, REORDER: 3, OK: 7 },
  finalByCategory: {
    "Solar Panels": 48,
    Inverters: 8,
    Batteries: 14,
    "EV Chargers": 7,
    "Mounting & Protection": 268,
  },
  batchRecords: { created: 35, already_present: 0 },
  batchMovements: 15,
};

export async function measureState(client: pg.ClientBase | pg.Pool): Promise<StateMeasurement> {
  const { rows } = await client.query<{ m: Omit<StateMeasurement, "movementsByType" | "statusCounts" | "finalByCategory"> & Record<string, unknown> }>(
    `select json_build_object(
       'counts', json_build_object(
         'auth_users', (select count(*)::int from auth.users), 'profiles', (select count(*)::int from public.profiles),
         'categories', (select count(*)::int from public.categories), 'locations', (select count(*)::int from public.locations),
         'suppliers', (select count(*)::int from public.suppliers), 'projects', (select count(*)::int from public.projects),
         'products', (select count(*)::int from public.products), 'stock_movements', (select count(*)::int from public.stock_movements),
         'import_batches', (select count(*)::int from public.import_batches), 'import_records', (select count(*)::int from public.import_records)),
       'movementsByType', coalesce((select json_object_agg(t.type, json_build_object('count', t.n, 'quantity', t.q))
          from (select type::text as type, count(*)::int as n, sum(quantity)::int as q from public.stock_movements group by type) t), '{}'::json),
       'productStock', (select count(*)::int from public.product_stock),
       'totalStock', (select coalesce(sum(balance), 0)::int from public.product_stock),
       'statusCounts', json_build_object(
         'OUT_OF_STOCK', (select count(*)::int from public.product_stock where status = 'OUT_OF_STOCK'),
         'REORDER', (select count(*)::int from public.product_stock where status = 'REORDER'),
         'OK', (select count(*)::int from public.product_stock where status = 'OK')),
       'finalByCategory', coalesce((select json_object_agg(c.category_name, c.total)
          from (select category_name, sum(balance)::int as total from public.product_stock group by category_name) c), '{}'::json)
     ) as m`,
  );
  return rows[0].m as unknown as StateMeasurement;
}

export async function measureBatch(client: pg.ClientBase | pg.Pool, batchId: string, identityId: string): Promise<BatchMeasurement> {
  const { rows } = await client.query<BatchMeasurement>(
    `select
       json_build_object(
         'created', (select count(*)::int from public.import_records where batch_id = $1 and action = 'created'),
         'already_present', (select count(*)::int from public.import_records where batch_id = $1 and action = 'already_present')) as "batchRecords",
       (select count(*)::int from public.import_records r join public.stock_movements m on m.id = r.entity_id
         where r.batch_id = $1 and r.entity_type = 'stock_movement') as "batchMovements",
       (select count(*)::int from public.import_records r join public.stock_movements m on m.id = r.entity_id
         where r.batch_id = $1 and r.entity_type = 'stock_movement' and m.user_id <> $2) as "movementsNotByIdentity",
       coalesce((select executed_by = $2 from public.import_batches where id = $1), false) as "batchExecutedByIdentity"`,
    [batchId, identityId],
  );
  return rows[0];
}

/** Canonical JSON (sorted keys) so object key order never matters. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v));

export function invariantProblems(state: StateMeasurement, batch: BatchMeasurement, expected: ApplyInvariants): string[] {
  const problems: string[] = [];
  const compare = (name: string, actual: unknown, wanted: unknown) => {
    if (canonical(actual) !== canonical(wanted)) problems.push(`${name}: ${canonical(actual)} ≠ ${canonical(wanted)}`);
  };
  compare("contagens", state.counts, expected.counts);
  compare("movimentos por tipo", state.movementsByType, expected.movementsByType);
  compare("product_stock", state.productStock, expected.productStock);
  compare("estoque total", state.totalStock, expected.totalStock);
  compare("estados", state.statusCounts, expected.statusCounts);
  compare("totais por categoria", state.finalByCategory, expected.finalByCategory);
  compare("registos do batch", batch.batchRecords, expected.batchRecords);
  compare("movimentos do batch", batch.batchMovements, expected.batchMovements);
  if (batch.movementsNotByIdentity !== 0) problems.push(`${batch.movementsNotByIdentity} movimento(s) do batch fora da identidade técnica`);
  if (!batch.batchExecutedByIdentity) problems.push("import_batches.executed_by não é a identidade técnica");
  return problems;
}

/**
 * Invariants = measured starting state + what the plan adds on a fresh target.
 * Used to check CANONICAL_APPLY_INVARIANTS against the canonical plan, and by
 * local tests whose database already holds other data.
 */
export function deriveApplyInvariants(base: StateMeasurement, plan: ImportPlan): ApplyInvariants {
  const movementsByType = structuredClone(base.movementsByType);
  for (const m of plan.movements) {
    const entry = (movementsByType[m.type] ??= { count: 0, quantity: 0 });
    entry.count += 1;
    entry.quantity += m.quantity;
  }
  const statusCounts = { ...base.statusCounts };
  const finalByCategory = { ...base.finalByCategory };
  const categoryName = new Map(plan.categories.map((c) => [c.prefix, c.name]));
  const productCategory = new Map(plan.products.map((p) => [p.code, categoryName.get(p.categoryPrefix)!]));
  let added = 0;
  for (const p of expectedProductState(plan)) {
    statusCounts[p.status] += 1;
    const name = productCategory.get(p.code)!;
    finalByCategory[name] = (finalByCategory[name] ?? 0) + p.balance;
    added += p.balance;
  }
  return {
    counts: {
      ...base.counts,
      categories: base.counts.categories + plan.categories.length,
      locations: base.counts.locations + plan.locations.length,
      products: base.counts.products + plan.products.length,
      stock_movements: base.counts.stock_movements + plan.movements.length,
      import_batches: base.counts.import_batches + 1,
      import_records: base.counts.import_records + plan.records.length,
    },
    movementsByType,
    productStock: base.productStock + plan.products.length,
    totalStock: base.totalStock + added,
    statusCounts,
    finalByCategory,
    batchRecords: { created: plan.records.length, already_present: 0 },
    batchMovements: plan.movements.length,
  };
}

export interface HostedApplyDeps extends HostedSessionDeps {
  invariants: ApplyInvariants;
}

export class HostedApplyUncertainError extends Error {
  constructor(
    readonly stage: "commit" | "pós-COMMIT",
    readonly problems: string[],
    readonly observed: { state: StateMeasurement; identityUnchanged: boolean } | null,
  ) {
    super(`APPLY hospedado requer revisão manual (${stage}): ${problems.join("; ")}`);
    this.name = "HostedApplyUncertainError";
  }
}

export interface HostedApplyReport {
  binding: { linkedProject: true; sameAuthUsersAsLinkedCli: true; identityId: string };
  precheck: TableCounts;
  inTransaction: Pick<InTransactionResult, "counts" | "movementsByType" | "batchRecords" | "batchId"> & { outcome: Pick<InTransactionResult["outcome"], "records" | "summary"> };
  gate: { state: StateMeasurement; batch: BatchMeasurement };
  committed: true;
  postCommit: { state: StateMeasurement; batch: BatchMeasurement; identityUnchanged: boolean };
}

async function observe(deps: HostedApplyDeps, before: { identity: string }, batchId: string | null, identityId: string) {
  return readOnly(deps, async (client) => ({
    state: await measureState(client),
    batch: batchId ? await measureBatch(client, batchId, identityId) : null,
    identityUnchanged: (await snapshot(client)).identity === before.identity,
  }));
}

export async function runHostedApply(plan: ImportPlan, deps: HostedApplyDeps): Promise<HostedApplyReport> {
  const before = await runHostedPrechecks(deps);

  let phase: "open" | "commit-sent" | "committed" = "open";
  let inTransaction: InTransactionResult | undefined;
  let gate: HostedApplyReport["gate"] | undefined;
  try {
    const client = await deps.connect();
    try {
      await client.query("begin");
      try {
        inTransaction = await importInSession(client, plan, deps, before);
        const state = await measureState(client);
        const batch = await measureBatch(client, inTransaction.batchId, before.identityId);
        const problems = invariantProblems(state, batch, deps.invariants);
        if (problems.length > 0) refuse("invariantes pré-COMMIT", problems);
        gate = { state, batch };

        phase = "commit-sent";
        await client.query("commit");
        phase = "committed";
      } finally {
        if (phase === "open") await client.query("rollback");
      }
    } finally {
      await client.end();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    if (phase === "open") {
      // Nothing was committed: prove the baseline on a new read-only connection.
      const state = await postcheck(deps, before.counts, before).catch((): PostcheckReport | null => null);
      if (error instanceof HostedImportError) throw new HostedImportError(error.stage, error.problems, state);
      throw new HostedImportError("apply", [message], state);
    }
    // COMMIT was sent but its outcome is unknown: report the observed state, never retry.
    const observed = await observe(deps, before, inTransaction?.batchId ?? null, before.identityId).catch(() => null);
    throw new HostedApplyUncertainError("commit", [message], observed ? { state: observed.state, identityUnchanged: observed.identityUnchanged } : null);
  }

  // Post-COMMIT verification on a NEW read-only connection. Data is already persisted.
  const after = await observe(deps, before, inTransaction!.batchId, before.identityId);
  const problems = invariantProblems(after.state, after.batch!, deps.invariants);
  if (!after.identityUnchanged) problems.push("identidade técnica alterada");
  if (problems.length > 0) throw new HostedApplyUncertainError("pós-COMMIT", problems, { state: after.state, identityUnchanged: after.identityUnchanged });

  return {
    binding: { linkedProject: true, sameAuthUsersAsLinkedCli: true, identityId: before.identityId },
    precheck: before.counts,
    inTransaction: {
      counts: inTransaction!.counts,
      movementsByType: inTransaction!.movementsByType,
      batchRecords: inTransaction!.batchRecords,
      batchId: inTransaction!.batchId,
      outcome: { records: inTransaction!.outcome.records, summary: inTransaction!.outcome.summary },
    },
    gate: gate!,
    committed: true,
    postCommit: { state: after.state, batch: after.batch!, identityUnchanged: after.identityUnchanged },
  };
}
