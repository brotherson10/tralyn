/**
 * Provisions the technical import identity ("Importação de dados") on the
 * LOCAL Supabase stack only.
 *
 *   npm run identity:provision:local
 *
 * Credentials are taken from `supabase status` (local CLI defaults) at run
 * time; nothing is read from .env files and no secret is printed. Any
 * non-local target is refused before a client is created.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { assertLocalTarget, IMPORT_IDENTITY, TargetNotAllowedError } from "./import-identity/identity";
import {
  probeAuthenticationBlocked,
  ProvisionAbortedError,
  provisionImportIdentity,
  readIdentity,
} from "./import-identity/provision";

function linkedProjectRef(): string | null {
  try {
    return readFileSync("supabase/.temp/project-ref", "utf8").trim() || null;
  } catch {
    return null;
  }
}

function localStack(): { apiUrl: string; secretKey: string; publishableKey: string } {
  const raw = execSync("npx supabase status -o json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let status: Record<string, string>;
  try {
    status = JSON.parse(raw.slice(raw.indexOf("{"))) as Record<string, string>;
  } catch {
    // Never surface the parser message: it may quote part of the output (keys).
    throw new Error("Saída de `supabase status` inválida.");
  }
  if (!status.API_URL || !status.SECRET_KEY || !status.PUBLISHABLE_KEY) {
    throw new Error("Supabase local não está a correr (npm run db:start).");
  }
  return { apiUrl: status.API_URL, secretKey: status.SECRET_KEY, publishableKey: status.PUBLISHABLE_KEY };
}

async function main(): Promise<number> {
  const stack = localStack();
  // Guard first: refuses hosted URLs, unknown hosts or the linked project ref.
  assertLocalTarget(stack.apiUrl, [linkedProjectRef() ?? ""]);

  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  const admin = createClient<Database>(stack.apiUrl, stack.secretKey, options);
  const publicClient = createClient(stack.apiUrl, stack.publishableKey, options);

  const result = await provisionImportIdentity(admin);
  const blocked = await probeAuthenticationBlocked(publicClient);
  if (blocked) throw new ProvisionAbortedError("Autenticação não está bloqueada", [blocked]);
  const after = await readIdentity(admin);
  if (after.users[0]?.lastSignInAt) throw new ProvisionAbortedError("Sessão detetada", ["last_sign_in_at preenchido"]);

  console.log(
    JSON.stringify(
      {
        target: "local",
        outcome: result.outcome,
        userId: result.userId,
        email: IMPORT_IDENTITY.email,
        profile: after.profile,
        bannedUntil: after.users[0]?.bannedUntil,
        passwordSet: false,
        authenticationBlocked: true,
      },
      null,
      2,
    ),
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof TargetNotAllowedError) {
      console.error(error.message);
      process.exit(2);
    }
    if (error instanceof ProvisionAbortedError) {
      console.error(`ABORTADO — ${error.message}`);
      process.exit(1);
    }
    console.error(`Erro: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
