/**
 * Canonical technical identity used as the responsible user of imported data
 * (import_batches.executed_by, stock_movements.user_id of imported rows).
 * It represents no real person and must never be able to authenticate.
 *
 * Pure logic only (no I/O), so it can be unit tested.
 */

export const IMPORT_IDENTITY = {
  email: "importacao@tralyn.invalid",
  name: "Importação de dados",
  role: "viewer",
  /** app_metadata marker (writable only with admin credentials) identifying the managed account. */
  marker: { key: "system_identity", value: "tralyn-import" },
} as const;

/**
 * Supabase Auth (GoTrue v2.197, auth-js 2.117) offers NO permanent ban and no
 * "disable authentication" switch in its public Admin API: `ban_duration` only
 * accepts a duration ("ns", "us", "ms", "s", "m", "h"; "none" lifts the ban).
 * Documented fallback: an explicit 100-year ban (100 × 365 × 24 h). The
 * account also has no password, an undeliverable .invalid e-mail and an
 * inactive profile, so the ban is one of several independent locks.
 */
export const BAN_DURATION = "876000h";
/** A valid identity must remain banned for at least this long from now. */
export const MIN_BAN_REMAINING_MS = 99 * 365 * 24 * 60 * 60 * 1000;

/** Local Supabase API (supabase/config.toml → [api] port). */
export const LOCAL_API_PORT = "54321";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class TargetNotAllowedError extends Error {
  constructor(reason: string) {
    super(`Alvo recusado: ${reason}. Nesta etapa só o Supabase LOCAL é permitido.`);
    this.name = "TargetNotAllowedError";
  }
}

/** Throws unless `apiUrl` is the local Supabase stack. Call BEFORE creating any client. */
export function assertLocalTarget(apiUrl: string, forbiddenRefs: readonly string[] = []): void {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new TargetNotAllowedError("URL inválida");
  }
  for (const ref of forbiddenRefs) {
    if (ref && apiUrl.includes(ref)) throw new TargetNotAllowedError("URL contém o project ref do projeto hospedado");
  }
  if (url.protocol !== "http:") throw new TargetNotAllowedError(`protocolo ${url.protocol} (o stack local usa http)`);
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new TargetNotAllowedError(`host ${url.hostname} não é local`);
  if (url.port !== LOCAL_API_PORT) throw new TargetNotAllowedError(`porta ${url.port || "(padrão)"} ≠ ${LOCAL_API_PORT}`);
}

// -----------------------------------------------------------------------------
// State evaluation
// -----------------------------------------------------------------------------
export interface AuthUserState {
  id: string;
  email: string | null;
  emailConfirmedAt: string | null;
  bannedUntil: string | null;
  lastSignInAt: string | null;
  deletedAt: string | null;
  isAnonymous: boolean;
  appMetadata: Record<string, unknown>;
}

export interface ProfileState {
  id: string;
  name: string;
  role: string;
  active: boolean;
}

export interface IdentitySnapshot {
  /** Every Auth user whose e-mail matches the canonical one (case-insensitive). */
  users: AuthUserState[];
  /** Profile of users[0], when exactly one user exists. */
  profile: ProfileState | null;
}

/**
 * Lists every difference between the snapshot and the expected identity.
 * `expectActive` is true only right after this run created the account
 * (before deactivating the profile); otherwise the profile must be inactive.
 */
export function identityProblems(snapshot: IdentitySnapshot, now: Date, expectActive = false): string[] {
  const problems: string[] = [];
  if (snapshot.users.length !== 1) {
    return [`esperado exatamente 1 utilizador com o email canónico, encontrados ${snapshot.users.length}`];
  }
  const [user] = snapshot.users;

  if (user.email !== IMPORT_IDENTITY.email) problems.push(`email "${user.email}" difere do canónico`);
  if (!user.emailConfirmedAt) problems.push("email não confirmado");
  if (user.deletedAt) problems.push("utilizador marcado como apagado (soft delete)");
  if (user.isAnonymous) problems.push("utilizador anónimo");
  if (user.appMetadata[IMPORT_IDENTITY.marker.key] !== IMPORT_IDENTITY.marker.value) {
    problems.push("marcador app_metadata da identidade técnica ausente ou diferente");
  }
  const bannedUntil = user.bannedUntil ? Date.parse(user.bannedUntil) : Number.NaN;
  if (!Number.isFinite(bannedUntil)) problems.push("autenticação não bloqueada (sem banimento)");
  else if (bannedUntil - now.getTime() < MIN_BAN_REMAINING_MS) problems.push("banimento demasiado curto ou expirado");
  if (user.lastSignInAt) problems.push("a identidade já iniciou sessão (last_sign_in_at preenchido)");

  const profile = snapshot.profile;
  if (!profile) {
    problems.push("profile inexistente");
  } else {
    if (profile.id !== user.id) problems.push("profile.id difere do id do utilizador Auth");
    if (profile.name !== IMPORT_IDENTITY.name) problems.push(`profile.name "${profile.name}" difere de "${IMPORT_IDENTITY.name}"`);
    if (profile.role !== IMPORT_IDENTITY.role) problems.push(`profile.role "${profile.role}" difere de "${IMPORT_IDENTITY.role}"`);
    if (profile.active !== expectActive) problems.push(`profile.active=${profile.active}, esperado ${expectActive}`);
  }
  return problems;
}
