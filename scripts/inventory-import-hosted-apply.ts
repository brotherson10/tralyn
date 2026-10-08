/**
 * APPLY (persisting import) of the legacy inventory into the HOSTED project
 * named by SUPABASE_PROJECT_REF. Separate from the dry-run CLI on purpose.
 *
 *   npx tsx --env-file=<ficheiro .env ignorado pelo Git> scripts/inventory-import-hosted-apply.ts \
 *     --file=fixtures/tralyn-demo.xlsx \
 *     --confirm-project=<SUPABASE_PROJECT_REF> \
 *     --confirm-sha256=<CANONICAL_EXPECTATIONS.sha256> \
 *     --confirm-apply=IMPORT-345-UNITS
 *
 * Requires the pristine hosted baseline (2/2, every business/audit table 0).
 * COMMIT only after every pre-COMMIT invariant holds; otherwise ROLLBACK.
 *
 * Environment (set by the operator, never printed):
 *   SUPABASE_PROJECT_REF               ref of the ONLY project this tool may touch (required, no default)
 *   INVENTORY_HOSTED_DATABASE_URL      direct or session-pooler connection string of the project
 *   INVENTORY_HOSTED_DATABASE_CA_FILE  path to the project's CA certificate
 *
 * Exit: 0 committed and verified · 1 failed, rolled back (nothing persisted) ·
 *       2 refused before connecting · 3 needs manual review (COMMIT outcome
 *       unknown or post-COMMIT verification differs; never retried).
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { HOSTED_BASELINE, HOSTED_PROJECT_REF_ENV, HostedTargetError, hostedProjectFromEnv, redactSecrets } from "./import-identity/hosted";
import { readHostedFacts, readHostedLinkedProject } from "./import-identity/hosted-runtime";
import { CANONICAL_EXPECTATIONS } from "./inventory-import/expectations";
import { APPLY_CONFIRMATION, CANONICAL_APPLY_INVARIANTS, HostedApplyUncertainError, runHostedApply } from "./inventory-import/hosted-apply";
import { HOSTED_INVENTORY_BASELINE, HostedImportError, hostedConnector } from "./inventory-import/hosted-session";
import {
  assertHostedDatabaseUrl,
  HOSTED_DATABASE_CA_ENV,
  HOSTED_DATABASE_URL_ENV,
  HostedImportTargetError,
  readHostedCa,
} from "./inventory-import/hosted-target";
import { CANONICAL_DB_EXPECTATIONS } from "./inventory-import/importer";
import { buildImportPlan } from "./inventory-import/pipeline";

const ARGS = ["--file", "--confirm-project", "--confirm-sha256", "--confirm-apply"];
const USAGE = `Uso: inventory-import-hosted-apply.ts --file=<${CANONICAL_EXPECTATIONS.fileName}> --confirm-project=<${HOSTED_PROJECT_REF_ENV}> --confirm-sha256=${CANONICAL_EXPECTATIONS.sha256} --confirm-apply=${APPLY_CONFIRMATION}`;

class UsageError extends Error {}

function parseArgs(argv: string[]) {
  const values: Record<string, string> = {};
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    if (!ARGS.includes(key) || rest.length === 0 || key in values) throw new UsageError(USAGE);
    values[key] = rest.join("=");
  }
  if (!values["--file"]) throw new UsageError(USAGE);
  return values;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const project = hostedProjectFromEnv();

  // Every confirmation is checked before reading any credential or opening any connection.
  const problems: string[] = [];
  if (args["--confirm-project"] !== project.ref) problems.push(`--confirm-project=${project.ref}`);
  if (args["--confirm-sha256"] !== CANONICAL_EXPECTATIONS.sha256) problems.push(`--confirm-sha256=${CANONICAL_EXPECTATIONS.sha256}`);
  if (args["--confirm-apply"] !== APPLY_CONFIRMATION) problems.push(`--confirm-apply=${APPLY_CONFIRMATION}`);
  if (problems.length > 0) throw new UsageError(`Confirmação em falta ou incorreta: ${problems.join(" ")}`);

  const target = assertHostedDatabaseUrl(process.env[HOSTED_DATABASE_URL_ENV], project.ref);
  const ca = readHostedCa(process.env[HOSTED_DATABASE_CA_ENV]);

  let bytes: Buffer;
  try {
    bytes = readFileSync(args["--file"]);
  } catch {
    throw new UsageError("Ficheiro não encontrado ou ilegível.");
  }
  const result = buildImportPlan({ fileName: basename(args["--file"]), bytes });
  if (!result.ok) {
    console.log(JSON.stringify({ mode: "apply", valid: false, errors: result.errors }, null, 2));
    return 1;
  }
  if (result.plan.source.sha256 !== args["--confirm-sha256"]) throw new UsageError("O SHA-256 do ficheiro não corresponde à confirmação.");

  const report = await runHostedApply(result.plan, {
    project,
    connect: hostedConnector(target, ca),
    readLinkedProject: readHostedLinkedProject,
    readCliFacts: readHostedFacts,
    identityBaseline: HOSTED_BASELINE,
    dataBaseline: HOSTED_INVENTORY_BASELINE,
    importOptions: { policy: "pristine", expectations: CANONICAL_DB_EXPECTATIONS },
    invariants: CANONICAL_APPLY_INVARIANTS,
  });

  const { summary, records } = report.inTransaction.outcome;
  console.log(
    JSON.stringify(
      {
        project: project.ref,
        target: { kind: target.kind, port: target.port, database: target.database, tls: "verify-full" },
        mode: "apply",
        committed: report.committed,
        file: { name: result.plan.source.fileName, sha256: result.plan.source.sha256 },
        binding: { linkedProject: report.binding.linkedProject, sameAuthUsersAsLinkedCli: report.binding.sameAuthUsersAsLinkedCli },
        precheck: report.precheck,
        batch: { id: report.inTransaction.batchId, records: { total: records.total, created: records.created, alreadyPresent: records.alreadyPresent } },
        reconciliation: {
          openingBalances: summary.openingBalances,
          openingQuantity: summary.openingQuantity,
          historicalMovements: summary.historicalMovements,
          historicalNet: summary.historicalNet,
          finalQuantity: summary.finalQuantity,
          statusCounts: summary.statusCounts,
          finalByCategory: summary.finalByCategory,
        },
        gate: report.gate,
        postCommit: report.postCommit,
      },
      null,
      2,
    ),
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const url = process.env[HOSTED_DATABASE_URL_ENV];
    let password: string | undefined;
    try {
      password = url ? decodeURIComponent(new URL(url).password) : undefined;
    } catch {
      password = undefined;
    }
    const clean = (text: string) => redactSecrets(text, [url, password]);
    if (error instanceof UsageError || error instanceof HostedImportTargetError || error instanceof HostedTargetError) {
      console.error(`RECUSADO — ${clean(error.message)}`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof HostedApplyUncertainError) {
      console.error(`REVISÃO MANUAL NECESSÁRIA — ${clean(error.message)}`);
      if (error.observed) console.error(`ESTADO OBSERVADO (read-only) — ${JSON.stringify(error.observed)}`);
      process.exitCode = 3;
      return;
    }
    // Message only (never the error object, stack or connection settings).
    console.error(`FALHOU (rollback, nada persistido) — ${clean(error instanceof Error ? error.message : "erro desconhecido")}`);
    if (error instanceof HostedImportError && error.postcheck) console.error(`PÓS-CHECK (read-only) — ${JSON.stringify(error.postcheck)}`);
    process.exitCode = 1;
  });
