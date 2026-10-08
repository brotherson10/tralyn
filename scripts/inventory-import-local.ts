/**
 * Transactional import of the legacy inventory into a LOCAL PostgreSQL only.
 *
 *   npm run inventory:import:local -- --dry-run --file=fixtures/tralyn-demo.xlsx
 *   npm run inventory:import:local -- --apply --file=fixtures/tralyn-demo.xlsx \
 *     --confirm-sha256=<sha256>
 *
 * The connection string is read ONLY from INVENTORY_IMPORT_DATABASE_URL and
 * must point to loopback (hosted projects are refused). It is never printed.
 * The target policy is always "pristine". Exit: 0 ok, 1 import failed
 * (rolled back), 2 usage / refused target / missing confirmation.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { redactSecrets } from "./import-identity/hosted";
import { CANONICAL_EXPECTATIONS } from "./inventory-import/expectations";
import { CANONICAL_DB_EXPECTATIONS, ImportAbortedError, runImport } from "./inventory-import/importer";
import { buildImportPlan } from "./inventory-import/pipeline";
import { assertLocalDatabaseUrl, DATABASE_URL_ENV, ImportTargetError } from "./inventory-import/target";

const USAGE =
  "Uso: inventory:import:local -- (--dry-run | --apply --confirm-sha256=<sha256>) --file=<workbook.xlsx>";

function parseArgs(argv: string[]) {
  const options: { mode: "dry-run" | "apply" | null; file: string | null; confirmSha: string | null; invalid: boolean } = {
    mode: null,
    file: null,
    confirmSha: null,
    invalid: false,
  };
  for (const arg of argv) {
    const [key, ...rest] = arg.split("=");
    const value = rest.join("=");
    if ((key === "--dry-run" || key === "--apply") && !rest.length && options.mode === null) options.mode = key === "--apply" ? "apply" : "dry-run";
    else if (key === "--file" && value && options.file === null) options.file = value;
    else if (key === "--confirm-sha256" && value && options.confirmSha === null) options.confirmSha = value;
    else options.invalid = true;
  }
  return options;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.invalid || !args.mode || !args.file || (args.mode === "dry-run" && args.confirmSha !== null)) {
    console.error(USAGE);
    return 2;
  }

  const connectionString = process.env[DATABASE_URL_ENV];
  const target = await assertLocalDatabaseUrl(connectionString);

  let bytes: Buffer;
  try {
    bytes = readFileSync(args.file);
  } catch {
    console.error("Ficheiro não encontrado ou ilegível.");
    return 2;
  }
  const fileName = basename(args.file);
  const result = buildImportPlan({ fileName, bytes });
  if (!result.ok) {
    console.log(JSON.stringify({ mode: args.mode, file: fileName, valid: false, errors: result.errors }, null, 2));
    return 1;
  }
  const { plan } = result;

  if (args.mode === "apply" && (args.confirmSha !== plan.source.sha256 || args.confirmSha !== CANONICAL_EXPECTATIONS.sha256)) {
    console.error(`Confirmação em falta ou incorreta: --confirm-sha256=${CANONICAL_EXPECTATIONS.sha256}`);
    return 2;
  }

  const outcome = await runImport(connectionString!, plan, args.mode, { policy: "pristine", expectations: CANONICAL_DB_EXPECTATIONS });
  console.log(
    JSON.stringify(
      {
        target: { kind: "local", host: target.host, port: target.port, database: target.database },
        mode: args.mode,
        committed: outcome.committed,
        file: { name: plan.source.fileName, sha256: plan.source.sha256 },
        batch: { id: outcome.batchId, importVersion: plan.source.importVersion, importedAt: outcome.importedAt, persisted: outcome.committed },
        executedBy: plan.executedByEmail,
        records: outcome.records,
        reconciliation: {
          categories: outcome.summary.categories,
          locations: outcome.summary.locations,
          products: outcome.summary.products,
          openingBalances: outcome.summary.openingBalances,
          openingQuantity: outcome.summary.openingQuantity,
          historicalMovements: outcome.summary.historicalMovements,
          historicalNet: outcome.summary.historicalNet,
          finalQuantity: outcome.summary.finalQuantity,
          statusCounts: outcome.summary.statusCounts,
          finalByCategory: outcome.summary.finalByCategory,
        },
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
    const connectionString = process.env[DATABASE_URL_ENV];
    let password: string | undefined;
    try {
      password = connectionString ? decodeURIComponent(new URL(connectionString).password) : undefined;
    } catch {
      password = undefined;
    }
    const message = error instanceof Error ? error.message : "erro desconhecido";
    const label = error instanceof ImportTargetError ? "RECUSADO" : error instanceof ImportAbortedError ? "ABORTADO (rollback)" : "ERRO (rollback)";
    // Message only (never the error object, stack or connection string).
    console.error(`${label} — ${redactSecrets(message, [connectionString, password])}`);
    process.exitCode = error instanceof ImportTargetError ? 2 : 1;
  });
