/**
 * HOSTED dry-run of the transactional importer, built from the shared steps in
 * hosted-session.ts. The transaction always ends in ROLLBACK; this module has
 * no code path that persists anything (persisting lives only in hosted-apply.ts).
 *
 *   prechecks (linked project, identity, read-only binding/baseline)
 *   → BEGIN → importInSession() → ROLLBACK (finally, unconditional)
 *   → read-only postcheck on a NEW connection (state identical to precheck)
 */
import type { ImportPlan } from "./model";
import {
  HostedImportError,
  importInSession,
  postcheck,
  refuse,
  runHostedPrechecks,
  type HostedSessionDeps,
  type InTransactionResult,
  type PostcheckReport,
  type TableCounts,
} from "./hosted-session";

export {
  COUNTED_TABLES,
  HOSTED_INVENTORY_BASELINE,
  hostedConnector,
  HostedImportError as HostedDryRunError,
  type PostcheckReport,
  type TableCounts,
} from "./hosted-session";

export type HostedDryRunDeps = HostedSessionDeps;

export interface HostedDryRunReport {
  binding: { linkedProject: true; sameAuthUsersAsLinkedCli: true; identityId: string };
  precheck: TableCounts;
  inTransaction: Omit<InTransactionResult, "batchId" | "outcome"> & { outcome: Pick<InTransactionResult["outcome"], "records" | "summary"> };
  rolledBack: true;
  postcheck: PostcheckReport;
}

export async function runHostedDryRun(plan: ImportPlan, deps: HostedDryRunDeps): Promise<HostedDryRunReport> {
  const before = await runHostedPrechecks(deps);

  // The dry-run transaction. ROLLBACK is unconditional (finally).
  let inTransaction: InTransactionResult;
  try {
    const client = await deps.connect();
    try {
      await client.query("begin");
      try {
        inTransaction = await importInSession(client, plan, deps, before);
      } finally {
        await client.query("rollback");
      }
    } finally {
      await client.end();
    }
  } catch (error) {
    // After any failure: read-only postcheck only, attached to the error.
    const state = await postcheck(deps, before.counts, before).catch(() => null);
    if (error instanceof HostedImportError) throw new HostedImportError(error.stage, error.problems, state);
    throw new HostedImportError("dry-run", [error instanceof Error ? error.message : "erro desconhecido"], state);
  }

  // Proof on a NEW connection that nothing persisted.
  const after = await postcheck(deps, before.counts, before);
  if (!after.backToBaseline || !after.identityUnchanged) refuse("pós-check", ["o estado após o rollback difere do pré-check"], after);

  return {
    binding: { linkedProject: true, sameAuthUsersAsLinkedCli: true, identityId: before.identityId },
    precheck: before.counts,
    inTransaction: {
      counts: inTransaction.counts,
      movementsByType: inTransaction.movementsByType,
      batchRecords: inTransaction.batchRecords,
      outcome: { records: inTransaction.outcome.records, summary: inTransaction.outcome.summary },
    },
    rolledBack: true,
    postcheck: after,
  };
}
