/**
 * HOSTED provisioning of the technical import identity ("Importação de dados").
 * Separate from the local tool (scripts/provision-import-identity.ts), which
 * keeps refusing any non-local target.
 *
 *   CHECK (read-only):
 *     npx tsx --env-file=<ficheiro .env ignorado pelo Git> scripts/hosted-import-identity.ts check
 *     (without --env-file the admin-key cross-check is reported as not_provided)
 *
 *   APPLY (creates the identity once; requires both confirmations):
 *     npx tsx --env-file=<ficheiro .env ignorado pelo Git> scripts/hosted-import-identity.ts apply \
 *       --confirm-project=<SUPABASE_PROJECT_REF> \
 *       --confirm-identity=importacao@tralyn.invalid
 *
 * The admin key is read ONLY from the process environment
 * (SUPABASE_SERVICE_ROLE_KEY) and is never printed. The target is the single
 * project named by SUPABASE_PROJECT_REF (required, no default); there is no
 * URL option.
 */
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertHostedTarget, HOSTED_BASELINE, HostedTargetError, hostedProjectFromEnv, parseArgs, redactSecrets } from "./import-identity/hosted";
import {
  ApplyRefusedError,
  checkExitCode,
  readHostedFacts,
  readHostedLinkedProject,
  runApply,
  runCheck,
  type HostedDeps,
} from "./import-identity/hosted-runtime";
import { ProvisionAbortedError } from "./import-identity/provision";

const KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY";

async function main(): Promise<number> {
  const { mode, confirmation, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length > 0 || (mode !== "check" && mode !== "apply")) {
    console.error("Uso: hosted-import-identity.ts check | apply --confirm-project=<ref> --confirm-identity=<email>");
    return 2;
  }

  const project = hostedProjectFromEnv();
  assertHostedTarget(project.url, project);
  const key = process.env[KEY_ENV]?.trim() || null;
  const admin = key
    ? createClient<Database>(project.url, key, { auth: { persistSession: false, autoRefreshToken: false } })
    : null;
  const deps: HostedDeps = {
    project,
    readFacts: readHostedFacts,
    readLinkedProject: readHostedLinkedProject,
    admin,
    baseline: HOSTED_BASELINE,
  };

  if (mode === "check") {
    const report = await runCheck(deps);
    console.log(JSON.stringify({ mode, project: project.ref, ...report }, null, 2));
    return checkExitCode(report);
  }

  const result = await runApply(deps, confirmation);
  console.log(
    JSON.stringify(
      {
        mode,
        project: project.ref,
        outcome: result.outcome,
        userId: result.userId,
        state: result.after.state,
        authUsers: result.after.authUsers,
        profiles: result.after.profiles,
        passwordSet: false,
      },
      null,
      2,
    ),
  );
  return 0;
}

// exitCode (not process.exit) so open fetch handles close cleanly on Windows.
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const secret = process.env[KEY_ENV];
    const message = error instanceof Error ? error.message : "erro desconhecido";
    const label =
      error instanceof HostedTargetError || error instanceof ApplyRefusedError
        ? "RECUSADO"
        : error instanceof ProvisionAbortedError
          ? "ABORTADO"
          : "ERRO";
    // Only the message (never the error object or stack), with secrets masked.
    console.error(`${label} — ${redactSecrets(message, [secret])}`);
    process.exitCode = error instanceof ApplyRefusedError || error instanceof HostedTargetError ? 2 : 1;
  });
