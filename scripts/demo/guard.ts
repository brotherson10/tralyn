/**
 * Hard LOCAL-ONLY guard for the demo bootstrap. Pure (no I/O): the CLI
 * collects the facts and refuses to run when ANY problem is reported.
 * There is deliberately no option to bypass it and no hosted mode.
 */
import { assertLocalTarget, TargetNotAllowedError } from "../import-identity/identity";

export const DEMO_PROJECT_ID = "tralyn";
export const LOCAL_DB_PORT = "54322";

/**
 * Variables that could point a tool at a hosted project, or that only make
 * sense for hosted administration. Their mere presence refuses the run.
 */
export const FORBIDDEN_ENV = [
  "SUPABASE_PROJECT_REF",
  "SUPABASE_PROJECT_ID",
  "SUPABASE_DB_URL",
  "SUPABASE_DB_PASSWORD",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ACCESS_TOKEN",
  "DATABASE_URL",
  "INVENTORY_HOSTED_DATABASE_URL",
  "INVENTORY_HOSTED_DATABASE_CA_FILE",
  "PGHOST",
  "PGHOSTADDR",
  "PGSERVICE",
] as const;

/** Variables tolerated only when they point at the loopback stack. */
export const LOOPBACK_ONLY_ENV = ["NEXT_PUBLIC_SUPABASE_URL", "INVENTORY_IMPORT_DATABASE_URL"] as const;

export interface DemoTargetFacts {
  env: Record<string, string | undefined>;
  /** project_id from supabase/config.toml (null when unreadable). */
  projectId: string | null;
  /** Ref in supabase/.temp/project-ref, if the CLI was ever linked to a hosted project. */
  linkedRef: string | null;
  /** From `supabase status` (undefined when the local stack is not running). */
  apiUrl?: string;
  dbUrl?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLoopbackUrl(value: string): boolean {
  try {
    return LOOPBACK.has(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function demoTargetProblems(facts: DemoTargetFacts): string[] {
  const problems: string[] = [];

  for (const name of FORBIDDEN_ENV) {
    if (facts.env[name]?.trim()) problems.push(`variável ${name} definida (só usada para projetos hospedados)`);
  }
  for (const name of LOOPBACK_ONLY_ENV) {
    const value = facts.env[name]?.trim();
    if (value && !isLoopbackUrl(value)) problems.push(`variável ${name} não aponta para o stack local`);
  }

  if (facts.projectId !== DEMO_PROJECT_ID) problems.push(`project_id "${facts.projectId ?? "?"}" ≠ "${DEMO_PROJECT_ID}"`);

  if (!facts.apiUrl || !facts.dbUrl) {
    problems.push("Supabase local não está a correr (npm run db:start)");
    return problems;
  }

  try {
    assertLocalTarget(facts.apiUrl, [facts.linkedRef ?? ""]);
  } catch (error) {
    problems.push(error instanceof TargetNotAllowedError ? `API: ${error.message}` : "API: URL inválida");
  }

  let db: URL | null = null;
  try {
    db = new URL(facts.dbUrl);
  } catch {
    problems.push("DB: connection string inválida");
  }
  if (db) {
    if (db.protocol !== "postgresql:" && db.protocol !== "postgres:") problems.push("DB: protocolo não PostgreSQL");
    if (!LOOPBACK.has(db.hostname)) problems.push(`DB: host ${db.hostname} não é local`);
    if (db.port !== LOCAL_DB_PORT) problems.push(`DB: porta ${db.port || "(padrão)"} ≠ ${LOCAL_DB_PORT}`);
    if (db.search || db.hash) problems.push("DB: parâmetros na connection string não são permitidos");
    if (facts.linkedRef && facts.dbUrl.includes(facts.linkedRef)) problems.push("DB: contém o project ref do projeto hospedado");
  }
  return problems;
}

/** The CLI takes no arguments at all: no --force, --hosted, --url or similar escape hatch. */
export function demoArgsProblems(argv: readonly string[]): string[] {
  return argv.length === 0 ? [] : [`argumentos não suportados: ${argv.join(" ")}`];
}
