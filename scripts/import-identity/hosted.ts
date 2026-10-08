/**
 * Pure logic for the HOSTED provisioning tool (separate from the local one).
 * Reuses the canonical identity and drift rules from ./identity.
 *
 * Nothing here performs I/O, so every rule is unit tested.
 */
import { IMPORT_IDENTITY, identityProblems, type IdentitySnapshot } from "./identity";

export class HostedTargetError extends Error {
  constructor(reason: string) {
    super(`Alvo remoto recusado: ${reason}.`);
    this.name = "HostedTargetError";
  }
}

/** Environment variable naming the ONLY hosted project the administrative tools may touch. */
export const HOSTED_PROJECT_REF_ENV = "SUPABASE_PROJECT_REF";
/** Expected project name in the Supabase account (cross-checked against the linked CLI). */
export const HOSTED_PROJECT_NAME = "tralyn";

/** The hosted project a run is bound to (public identifiers, not secrets). */
export interface HostedProject {
  ref: string;
  name: string;
  url: string;
}

/** Supabase project refs are 20 lowercase letters. */
const PROJECT_REF = /^[a-z]{20}$/;

export function hostedProjectFromRef(ref: string): HostedProject {
  if (!PROJECT_REF.test(ref)) throw new HostedTargetError("project ref inválido (esperadas 20 letras minúsculas)");
  return { ref, name: HOSTED_PROJECT_NAME, url: `https://${ref}.supabase.co` };
}

/**
 * Resolves the hosted project from the process environment. Fails fast when
 * the variable is missing or malformed: there is no default and no fallback.
 */
export function hostedProjectFromEnv(env: Record<string, string | undefined> = process.env): HostedProject {
  const ref = env[HOSTED_PROJECT_REF_ENV]?.trim();
  if (!ref) throw new HostedTargetError(`variável ${HOSTED_PROJECT_REF_ENV} não definida`);
  return hostedProjectFromRef(ref);
}

/** Accepts exactly the bound project URL (https, exact host, no path/port/credentials). */
export function assertHostedTarget(apiUrl: string, project: HostedProject): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new HostedTargetError("URL inválida");
  }
  if (url.protocol !== "https:") throw new HostedTargetError(`protocolo ${url.protocol}`);
  if (url.username || url.password) throw new HostedTargetError("URL com credenciais");
  if (url.hostname !== `${project.ref}.supabase.co`) throw new HostedTargetError(`host ${url.hostname} não é o projeto esperado`);
  if (url.port) throw new HostedTargetError(`porta ${url.port}`);
  if (url.pathname !== "/" || url.search || url.hash) throw new HostedTargetError("URL com caminho ou parâmetros");
}

/** Linked project as reported by `supabase projects list` + the local link file. */
export interface LinkedProjectFacts {
  linkedRefFile: string | null;
  projects: { ref: string; name: string; status: string; linked: boolean }[];
}

export function linkedProjectProblems(facts: LinkedProjectFacts, project: HostedProject): string[] {
  const problems: string[] = [];
  if (facts.linkedRefFile !== project.ref) {
    problems.push(`projeto ligado no CLI é "${facts.linkedRefFile ?? "nenhum"}", esperado ${project.ref}`);
  }
  const linked = facts.projects.filter((p) => p.linked);
  if (linked.length !== 1 || linked[0].ref !== project.ref) {
    problems.push("a conta do CLI não reporta exatamente o projeto esperado como ligado");
  }
  const listed = facts.projects.find((p) => p.ref === project.ref);
  if (!listed) problems.push("projeto esperado não encontrado na conta do CLI");
  else {
    if (listed.name !== project.name) problems.push(`nome do projeto "${listed.name}" ≠ ${project.name}`);
    if (listed.status !== "ACTIVE_HEALTHY") problems.push(`estado do projeto ${listed.status}`);
  }
  return problems;
}

// -----------------------------------------------------------------------------
// APPLY confirmation (no secrets ever go through arguments)
// -----------------------------------------------------------------------------
export interface ApplyConfirmation {
  project: string | null;
  identity: string | null;
}

export function parseArgs(argv: readonly string[]): { mode: string | null; confirmation: ApplyConfirmation; unknown: string[] } {
  const [mode = null, ...rest] = argv;
  const confirmation: ApplyConfirmation = { project: null, identity: null };
  const unknown: string[] = [];
  for (const arg of rest) {
    const [key, ...value] = arg.split("=");
    if (key === "--confirm-project") confirmation.project = value.join("=");
    else if (key === "--confirm-identity") confirmation.identity = value.join("=");
    else unknown.push(key);
  }
  return { mode, confirmation, unknown };
}

/** APPLY requires BOTH the exact project ref and the exact identity e-mail. */
export function confirmationProblems(confirmation: ApplyConfirmation, project: HostedProject): string[] {
  const problems: string[] = [];
  if (confirmation.project !== project.ref) {
    problems.push(`confirmação em falta ou incorreta: --confirm-project=${project.ref}`);
  }
  if (confirmation.identity !== IMPORT_IDENTITY.email) {
    problems.push(`confirmação em falta ou incorreta: --confirm-identity=${IMPORT_IDENTITY.email}`);
  }
  return problems;
}

// -----------------------------------------------------------------------------
// Preflight (facts read with one read-only SQL query)
// -----------------------------------------------------------------------------
export interface PreflightFacts {
  auth_user_ids: string[];
  profiles: number;
  identity_users: {
    id: string;
    email: string | null;
    email_confirmed_at: string | null;
    banned_until: string | null;
    last_sign_in_at: string | null;
    deleted_at: string | null;
    is_anonymous: boolean;
    app_metadata: Record<string, unknown> | null;
  }[];
  identity_profiles: { id: string; name: string; role: string; active: boolean }[];
  counts: Record<string, number>;
  foreign_keys: { name: string; definition: string }[];
  trigger_enabled: boolean;
  trigger_creates_viewer: boolean;
  profiles_role_default: string | null;
}

/** Expected pre-creation state of the project. */
export interface Baseline {
  authUsers: number;
  profiles: number;
  /** Tables that must be empty before the identity is created. */
  emptyTables: readonly string[];
}

/** The hosted project today: only the real admin, no business or import data. */
export const HOSTED_BASELINE: Baseline = {
  authUsers: 1,
  profiles: 1,
  emptyTables: ["import_batches", "import_records", "products", "stock_movements"],
};

export const REQUIRED_FOREIGN_KEYS: Record<string, string> = {
  profiles_id_fkey: "FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE",
  stock_movements_user_id_fkey: "FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT",
  import_batches_executed_by_fkey: "FOREIGN KEY (executed_by) REFERENCES profiles(id) ON DELETE RESTRICT",
};

/** Single read-only statement collecting every fact the preflight needs. */
export const PREFLIGHT_SQL = `
select json_build_object(
  'auth_user_ids', (select coalesce(json_agg(id order by id), '[]'::json) from auth.users),
  'profiles', (select count(*) from public.profiles),
  'identity_users', (
    select coalesce(json_agg(json_build_object(
      'id', id, 'email', email, 'email_confirmed_at', email_confirmed_at, 'banned_until', banned_until,
      'last_sign_in_at', last_sign_in_at, 'deleted_at', deleted_at, 'is_anonymous', is_anonymous,
      'app_metadata', raw_app_meta_data)), '[]'::json)
    from auth.users where lower(email) = lower('${IMPORT_IDENTITY.email}')),
  'identity_profiles', (
    select coalesce(json_agg(json_build_object('id', id, 'name', name, 'role', role, 'active', active)), '[]'::json)
    from public.profiles
    where name = '${IMPORT_IDENTITY.name}'
       or id in (select id from auth.users where lower(email) = lower('${IMPORT_IDENTITY.email}'))),
  'counts', json_build_object(
    'import_batches', (select count(*) from public.import_batches),
    'import_records', (select count(*) from public.import_records),
    'products', (select count(*) from public.products),
    'stock_movements', (select count(*) from public.stock_movements)),
  'foreign_keys', (
    select coalesce(json_agg(json_build_object('name', conname, 'definition', pg_get_constraintdef(oid)) order by conname), '[]'::json)
    from pg_constraint
    where conname in ('profiles_id_fkey', 'stock_movements_user_id_fkey', 'import_batches_executed_by_fkey')
      and connamespace = 'public'::regnamespace),
  'trigger_enabled', exists (
    select 1 from pg_trigger
    where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'
      and tgfoid = 'private.handle_new_auth_user()'::regprocedure and tgenabled <> 'D'),
  'trigger_creates_viewer', coalesce((
    select prosrc ~ '''viewer''' from pg_proc where oid = 'private.handle_new_auth_user()'::regprocedure), false),
  'profiles_role_default', (
    select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles' and column_name = 'role')
) as facts`;

export type PreflightState = "ready_to_create" | "already_present";

export interface PreflightResult {
  state: PreflightState | null;
  problems: string[];
}

function toSnapshot(facts: PreflightFacts): IdentitySnapshot {
  const users = facts.identity_users.map((u) => ({
    id: u.id,
    email: u.email,
    emailConfirmedAt: u.email_confirmed_at,
    bannedUntil: u.banned_until,
    lastSignInAt: u.last_sign_in_at,
    deletedAt: u.deleted_at,
    isAnonymous: u.is_anonymous,
    appMetadata: u.app_metadata ?? {},
  }));
  const profile = users.length === 1 ? (facts.identity_profiles.find((p) => p.id === users[0].id) ?? null) : null;
  return { users, profile };
}

/**
 * Decides whether the project is in an expected state:
 *  - identity absent  → must match the pre-creation baseline → "ready_to_create";
 *  - identity present → must be exactly canonical → "already_present";
 *  - anything else    → problems (CHECK fails, APPLY aborts before writing).
 */
export function evaluatePreflight(facts: PreflightFacts, baseline: Baseline, now: Date): PreflightResult {
  const problems: string[] = [];

  // Schema invariants the identity relies on.
  for (const [name, definition] of Object.entries(REQUIRED_FOREIGN_KEYS)) {
    const found = facts.foreign_keys.find((fk) => fk.name === name);
    if (!found) problems.push(`FK ${name} em falta`);
    else if (found.definition !== definition) problems.push(`FK ${name} alterada: ${found.definition}`);
  }
  if (!facts.trigger_enabled) problems.push("trigger on_auth_user_created ausente ou desativado");
  if (!facts.trigger_creates_viewer) problems.push("handle_new_auth_user já não cria perfis 'viewer'");
  if (facts.profiles_role_default !== "'viewer'::app_role") {
    problems.push(`default de profiles.role alterado: ${facts.profiles_role_default}`);
  }

  const users = facts.identity_users.length;
  const strayProfiles = facts.identity_profiles.filter((p) => !facts.identity_users.some((u) => u.id === p.id));
  if (strayProfiles.length > 0) problems.push(`existe(m) ${strayProfiles.length} profile(s) "${IMPORT_IDENTITY.name}" fora da identidade canónica`);

  if (users === 0) {
    if (facts.auth_user_ids.length !== baseline.authUsers) {
      problems.push(`auth.users = ${facts.auth_user_ids.length}, esperado ${baseline.authUsers} antes da criação`);
    }
    if (facts.profiles !== baseline.profiles) problems.push(`profiles = ${facts.profiles}, esperado ${baseline.profiles} antes da criação`);
    for (const table of baseline.emptyTables) {
      if ((facts.counts[table] ?? -1) !== 0) problems.push(`${table} = ${facts.counts[table]}, esperado 0 antes da criação`);
    }
    return { state: problems.length === 0 ? "ready_to_create" : null, problems };
  }

  problems.push(...identityProblems(toSnapshot(facts), now));
  // After creation: exactly the baseline plus the identity, nothing else.
  if (facts.auth_user_ids.length !== baseline.authUsers + 1) {
    problems.push(`auth.users = ${facts.auth_user_ids.length}, esperado ${baseline.authUsers + 1} com a identidade`);
  }
  if (facts.profiles !== baseline.profiles + 1) {
    problems.push(`profiles = ${facts.profiles}, esperado ${baseline.profiles + 1} com a identidade`);
  }
  return { state: problems.length === 0 ? "already_present" : null, problems };
}

// -----------------------------------------------------------------------------
// Output hygiene
// -----------------------------------------------------------------------------
/** Masks known secrets and anything shaped like a Supabase key or JWT. */
export function redactSecrets(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[REDACTED]");
  }
  return out
    .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "sb_$1_[REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/(postgres(?:ql)?:\/\/[^:@/\s]+):[^@/\s]+@/g, "$1:[REDACTED]@");
}
