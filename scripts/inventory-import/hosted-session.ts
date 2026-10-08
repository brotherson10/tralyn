/**
 * Building blocks shared by the HOSTED dry-run and the HOSTED apply. They
 * never end a transaction themselves: the dry-run always rolls back, the
 * apply (hosted-apply.ts) is the only place allowed to persist.
 *
 *   runHostedPrechecks   linked project → identity via the linked CLI →
 *                        read-only precheck over pg (binding, baseline, identity)
 *   importInSession      inside the caller's transaction: binding re-check,
 *                        shared importPlan(), verification against baseline + plan
 *   measure / readOnly   read-only measurements on a NEW connection
 */
import pg from "pg";
import { IMPORT_IDENTITY } from "../import-identity/identity";
import { evaluatePreflight, linkedProjectProblems, type Baseline, type HostedProject, type LinkedProjectFacts, type PreflightFacts } from "../import-identity/hosted";
import { importPlan, resolveImportIdentity, type ImportOptions, type ImportOutcome } from "./importer";
import type { ImportPlan } from "./model";
import type { HostedDatabaseTarget } from "./hosted-target";

export const COUNTED_TABLES = [
  "categories",
  "locations",
  "suppliers",
  "projects",
  "products",
  "stock_movements",
  "import_batches",
  "import_records",
] as const;

export type TableCounts = Record<"auth_users" | "profiles" | (typeof COUNTED_TABLES)[number], number>;

/** The hosted project before the first import: real admin + technical identity, nothing else. */
export const HOSTED_INVENTORY_BASELINE: TableCounts = {
  auth_users: 2,
  profiles: 2,
  categories: 0,
  locations: 0,
  suppliers: 0,
  projects: 0,
  products: 0,
  stock_movements: 0,
  import_batches: 0,
  import_records: 0,
};

export interface HostedSessionDeps {
  /** The hosted project this run is bound to (from SUPABASE_PROJECT_REF). */
  project: HostedProject;
  /** Opens a NEW connection to the target database. */
  connect: () => Promise<pg.Client>;
  readLinkedProject: () => Promise<LinkedProjectFacts>;
  /** Facts read through the linked Supabase CLI (independent channel bound to the project ref). */
  readCliFacts: () => Promise<PreflightFacts>;
  /** Pre-identity baseline used by the identity rules (HOSTED_BASELINE for the hosted project). */
  identityBaseline: Baseline;
  /** Exact counts expected before the import. */
  dataBaseline: TableCounts;
  importOptions: ImportOptions;
  now?: () => Date;
}

export interface PostcheckReport {
  counts: TableCounts;
  backToBaseline: boolean;
  identityUnchanged: boolean;
}

export class HostedImportError extends Error {
  constructor(
    readonly stage: string,
    readonly problems: string[],
    /** Read-only state observed after a failure (null when it could not be read). */
    readonly postcheck: PostcheckReport | null = null,
  ) {
    super(`Importação hospedada interrompida (${stage}): ${problems.join("; ")}`);
    this.name = "HostedImportError";
  }
}

export const refuse = (stage: string, problems: string[], postcheck: PostcheckReport | null = null): never => {
  throw new HostedImportError(stage, problems, postcheck);
};

export const COUNTS_SQL = `select json_build_object(
  'auth_users', (select count(*)::int from auth.users),
  'profiles', (select count(*)::int from public.profiles),
  ${COUNTED_TABLES.map((t) => `'${t}', (select count(*)::int from public.${t})`).join(",\n  ")}
) as counts`;

/** Auth user ids (binding) + every identity attribute a change would touch. */
const FINGERPRINT_SQL = `select
  (select coalesce(json_agg(id::text order by id), '[]'::json) from auth.users) as auth_user_ids,
  (select json_agg(json_build_object(
      'id', u.id, 'email', u.email, 'email_confirmed_at', u.email_confirmed_at, 'banned_until', u.banned_until,
      'last_sign_in_at', u.last_sign_in_at, 'deleted_at', u.deleted_at, 'is_anonymous', u.is_anonymous,
      'updated_at', u.updated_at, 'app_metadata', u.raw_app_meta_data,
      'profile', (select json_build_object('name', p.name, 'role', p.role, 'active', p.active, 'updated_at', p.updated_at)
                    from public.profiles p where p.id = u.id)))
     from auth.users u where lower(u.email) = lower($1)) as identity`;

const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

export function countDiff(actual: TableCounts, expected: TableCounts): string[] {
  return (Object.keys(expected) as (keyof TableCounts)[]).filter((k) => actual[k] !== expected[k]).map((k) => `${k} = ${actual[k]}, esperado ${expected[k]}`);
}

/** Runs fn in a READ ONLY transaction on a NEW connection (always rolled back). */
export async function readOnly<T>(deps: Pick<HostedSessionDeps, "connect">, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = await deps.connect();
  try {
    await client.query("begin transaction read only");
    try {
      return await fn(client);
    } finally {
      await client.query("rollback");
    }
  } finally {
    await client.end();
  }
}

export interface Snapshot {
  counts: TableCounts;
  authUserIds: string[];
  /** Serialized identity fingerprint (compared before/after). */
  identity: string;
}

export async function snapshot(client: pg.ClientBase): Promise<Snapshot> {
  const counts = (await client.query<{ counts: TableCounts }>(COUNTS_SQL)).rows[0].counts;
  const fp = (await client.query<{ auth_user_ids: string[]; identity: unknown }>(FINGERPRINT_SQL, [IMPORT_IDENTITY.email])).rows[0];
  return { counts, authUserIds: fp.auth_user_ids, identity: JSON.stringify(fp.identity) };
}

export interface Precheck extends Snapshot {
  identityId: string;
}

/** Steps before any write: linked project, identity (CLI), read-only pg precheck with binding. */
export async function runHostedPrechecks(deps: HostedSessionDeps): Promise<Precheck> {
  const now = deps.now ?? (() => new Date());

  const linked = linkedProjectProblems(await deps.readLinkedProject(), deps.project);
  if (linked.length > 0) refuse("projeto ligado", linked);

  const cliFacts = await deps.readCliFacts();
  const identity = evaluatePreflight(cliFacts, deps.identityBaseline, now());
  if (identity.state !== "already_present") refuse("identidade técnica (CLI)", identity.problems.length ? identity.problems : ["identidade técnica ausente"]);

  return readOnly(deps, async (client) => {
    const snap = await snapshot(client);
    if (!sameSet(snap.authUserIds, cliFacts.auth_user_ids)) {
      refuse("binding", ["a ligação PostgreSQL não vê os mesmos utilizadores que o projeto ligado no CLI"]);
    }
    const diff = countDiff(snap.counts, deps.dataBaseline);
    if (diff.length > 0) refuse("pré-check", diff);
    const identityId = await resolveImportIdentity(client, now(), { lockProfile: false });
    if (identityId !== cliFacts.identity_users[0]?.id) refuse("binding", ["identidade técnica difere da vista pelo CLI"]);
    return { ...snap, identityId };
  });
}

export interface InTransactionResult {
  counts: TableCounts;
  movementsByType: Record<string, { count: number; quantity: number }>;
  batchRecords: { created: number; already_present: number };
  batchId: string;
  outcome: Pick<ImportOutcome, "records" | "summary" | "executedBy">;
}

/**
 * Inside the CALLER's open transaction (it decides how the transaction ends):
 * session limits, binding re-check, shared importPlan(), verification that the
 * target went from the precheck baseline to baseline + plan, everything created.
 */
export async function importInSession(client: pg.ClientBase, plan: ImportPlan, deps: HostedSessionDeps, before: Precheck): Promise<InTransactionResult> {
  await client.query("set local statement_timeout = '120s'");
  await client.query("set local lock_timeout = '15s'");
  await client.query("set local idle_in_transaction_session_timeout = '180s'");

  // Binding re-checked inside the very session that runs the import.
  const session = await snapshot(client);
  if (!sameSet(session.authUserIds, before.authUserIds) || session.identity !== before.identity) {
    refuse("binding", ["a sessão da importação não corresponde ao pré-check"]);
  }

  const outcome = await importPlan(client, plan, deps.importOptions);

  const counts = (await client.query<{ counts: TableCounts }>(COUNTS_SQL)).rows[0].counts;
  const movements = await client.query<{ type: string; n: number; qty: number }>(
    `select type::text as type, count(*)::int as n, sum(quantity)::int as qty from public.stock_movements group by type order by type`,
  );
  const records = await client.query<{ action: "created" | "already_present"; n: number }>(
    `select action, count(*)::int as n from public.import_records where batch_id = $1 group by action`,
    [outcome.batchId],
  );
  const batchRecords = { created: 0, already_present: 0 };
  for (const r of records.rows) batchRecords[r.action] = r.n;

  // Fresh target: everything in the plan is created exactly once.
  const expected: TableCounts = {
    ...before.counts,
    categories: before.counts.categories + plan.categories.length,
    locations: before.counts.locations + plan.locations.length,
    products: before.counts.products + plan.products.length,
    stock_movements: before.counts.stock_movements + plan.movements.length,
    import_batches: before.counts.import_batches + 1,
    import_records: before.counts.import_records + plan.records.length,
  };
  const problems = countDiff(counts, expected);
  if (batchRecords.created !== plan.records.length || batchRecords.already_present !== 0) {
    problems.push(`registos do batch ${JSON.stringify(batchRecords)}, esperado ${plan.records.length} created`);
  }
  if (outcome.executedBy !== before.identityId) problems.push("o batch não foi executado pela identidade técnica do pré-check");
  if (problems.length > 0) refuse("verificação na transação", problems);

  return {
    counts,
    movementsByType: Object.fromEntries(movements.rows.map((r) => [r.type, { count: r.n, quantity: r.qty }])),
    batchRecords,
    batchId: outcome.batchId,
    outcome: { records: outcome.records, summary: outcome.summary, executedBy: outcome.executedBy },
  };
}

/** Read-only comparison of the current state with an expected one, on a NEW connection. */
export async function postcheck(deps: Pick<HostedSessionDeps, "connect">, expected: TableCounts, before: Snapshot): Promise<PostcheckReport> {
  return readOnly(deps, async (client) => {
    const after = await snapshot(client);
    return {
      counts: after.counts,
      backToBaseline: countDiff(after.counts, expected).length === 0,
      identityUnchanged: after.identity === before.identity,
    };
  });
}

/** pg client for the guarded hosted target: explicit fields (no env fallbacks), verify-full TLS. */
export function hostedConnector(target: HostedDatabaseTarget, ca: string): () => Promise<pg.Client> {
  return async () => {
    const client = new pg.Client({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      database: target.database,
      ssl: { ca, rejectUnauthorized: true, servername: target.host },
      application_name: "tralyn-hosted-import",
      connectionTimeoutMillis: 20_000,
    });
    client.on("error", () => undefined); // dropped connection → server-side rollback; surfaced by the next query
    await client.connect();
    return client;
  };
}
