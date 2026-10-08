import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMPORT_IDENTITY } from "./identity";
import {
  confirmationProblems,
  evaluatePreflight,
  linkedProjectProblems,
  PREFLIGHT_SQL,
  type ApplyConfirmation,
  type Baseline,
  type HostedProject,
  type LinkedProjectFacts,
  type PreflightFacts,
  type PreflightState,
} from "./hosted";
import { provisionImportIdentity, ProvisionAbortedError, type AdminClient } from "./provision";

/**
 * Execution of the hosted CHECK / APPLY flows. All external access is
 * injected (HostedDeps), so the write path is only ever exercised locally or
 * with test doubles. The CLI wires the real hosted implementations.
 */

export interface HostedDeps {
  /** The hosted project this run is bound to (from SUPABASE_PROJECT_REF). */
  project: HostedProject;
  /** Read-only facts (one SELECT). */
  readFacts: () => Promise<PreflightFacts>;
  /** Linked project as seen by the Supabase CLI. */
  readLinkedProject: () => Promise<LinkedProjectFacts>;
  /** Auth Admin client for the expected project; null when no key was provided. */
  admin: AdminClient | null;
  baseline: Baseline;
  now?: () => Date;
}

export interface CheckReport {
  ok: boolean;
  state: PreflightState | null;
  keyCheck: "not_provided" | "ok" | "failed";
  problems: string[];
  authUsers: number;
  profiles: number;
  counts: Record<string, number>;
}

/** Proves the admin key reaches the SAME database as the linked CLI (identical auth user ids). */
async function adminKeyProblems(admin: AdminClient, sqlIds: readonly string[]): Promise<string[]> {
  const ids: string[] = [];
  for (let page = 1; ; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return [`a chave administrativa foi recusada pelo Auth do projeto (${error.status ?? "?"} ${error.code ?? ""})`];
    ids.push(...data.users.map((u) => u.id));
    if (data.users.length < 1000) break;
  }
  const a = [...ids].sort().join(",");
  const b = [...sqlIds].sort().join(",");
  return a === b ? [] : ["a chave administrativa não pertence ao projeto ligado (utilizadores diferentes)"];
}

/** CHECK: strictly read-only. */
export async function runCheck(deps: HostedDeps): Promise<CheckReport> {
  const now = deps.now ?? (() => new Date());
  const problems = linkedProjectProblems(await deps.readLinkedProject(), deps.project);
  const facts = await deps.readFacts();
  const preflight = evaluatePreflight(facts, deps.baseline, now());
  problems.push(...preflight.problems);

  let keyCheck: CheckReport["keyCheck"] = "not_provided";
  if (deps.admin) {
    const keyProblems = await adminKeyProblems(deps.admin, facts.auth_user_ids);
    keyCheck = keyProblems.length === 0 ? "ok" : "failed";
    problems.push(...keyProblems);
  }

  return {
    ok: problems.length === 0,
    state: problems.length === 0 ? preflight.state : null,
    keyCheck,
    problems,
    authUsers: facts.auth_user_ids.length,
    profiles: facts.profiles,
    counts: facts.counts,
  };
}

/** CLI exit code for a CHECK: 0 only when the project is in an expected state. */
export function checkExitCode(report: CheckReport): 0 | 1 {
  return report.ok && report.state !== null ? 0 : 1;
}

export class ApplyRefusedError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(`${message}: ${problems.join("; ")}`);
    this.name = "ApplyRefusedError";
  }
}

export interface ApplyResult {
  outcome: "created" | "already_present";
  userId: string;
  before: CheckReport;
  after: CheckReport;
}

/**
 * APPLY: confirmation → full preflight (incl. admin key cross-check) → create
 * via provisionImportIdentity → full re-check. Nothing else is written.
 *
 * Partial failure (account created, profile not yet inactive): the account is
 * already banned at creation; APPLY throws and every later CHECK/APPLY reports
 * drift and refuses — nothing is deleted, recreated or silently fixed.
 */
export async function runApply(deps: HostedDeps, confirmation: ApplyConfirmation): Promise<ApplyResult> {
  const refused = confirmationProblems(confirmation, deps.project);
  if (refused.length > 0) throw new ApplyRefusedError("Confirmação recusada", refused);
  if (!deps.admin) throw new ApplyRefusedError("Credencial administrativa ausente", ["defina a chave apenas no ambiente do processo"]);

  const before = await runCheck(deps);
  if (!before.ok) throw new ApplyRefusedError("Preflight falhou; nada foi escrito", before.problems);
  if (before.keyCheck !== "ok") throw new ApplyRefusedError("Chave administrativa não verificada", ["keyCheck"]);

  const facts = await deps.readFacts();
  if (before.state === "already_present") {
    const user = facts.identity_users[0];
    return { outcome: "already_present", userId: user.id, before, after: before };
  }

  const result = await provisionImportIdentity(deps.admin);

  const after = await runCheck(deps);
  if (!after.ok || after.state !== "already_present") {
    throw new ProvisionAbortedError("Estado final não verificado", after.problems.length ? after.problems : ["estado inesperado"]);
  }
  return { outcome: result.outcome, userId: result.userId, before, after };
}

// -----------------------------------------------------------------------------
// Real hosted implementations (used only by the CLI)
// -----------------------------------------------------------------------------
const CLI_ENTRY = join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");

/** Runs the Supabase CLI without a shell; never surfaces its output in errors. */
function supabaseCli(args: string[], what: string): string {
  try {
    return execFileSync(process.execPath, [CLI_ENTRY, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 120_000,
    });
  } catch {
    throw new Error(`Falha ao executar o Supabase CLI (${what}).`);
  }
}

function parseJson(raw: string, what: string): unknown {
  const start = Math.min(...["{", "["].map((c) => raw.indexOf(c)).filter((i) => i >= 0));
  const end = Math.max(raw.lastIndexOf("}"), raw.lastIndexOf("]"));
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error(`Resposta inválida do Supabase CLI (${what}).`);
  }
}

export async function readHostedLinkedProject(): Promise<LinkedProjectFacts> {
  let linkedRefFile: string | null = null;
  try {
    linkedRefFile = readFileSync(join(process.cwd(), "supabase", ".temp", "project-ref"), "utf8").trim() || null;
  } catch {
    linkedRefFile = null;
  }
  const parsed = parseJson(supabaseCli(["projects", "list", "-o", "json"], "projects list"), "projects list") as
    | { projects?: unknown[] }
    | unknown[];
  const list = (Array.isArray(parsed) ? parsed : (parsed.projects ?? [])) as Record<string, unknown>[];
  return {
    linkedRefFile,
    projects: list.map((p) => ({
      ref: String(p.ref ?? p.id ?? ""),
      name: String(p.name ?? ""),
      status: String(p.status ?? ""),
      linked: p.linked === true,
    })),
  };
}

/** Read-only: a single SELECT through `supabase db query --linked`. */
export async function readHostedFacts(): Promise<PreflightFacts> {
  if (!/^\s*select\b/i.test(PREFLIGHT_SQL) || /;\s*\S/.test(PREFLIGHT_SQL)) {
    throw new Error("PREFLIGHT_SQL tem de ser uma única instrução SELECT.");
  }
  const dir = mkdtempSync(join(tmpdir(), "tralyn-preflight-"));
  const file = join(dir, "preflight.sql");
  try {
    writeFileSync(file, PREFLIGHT_SQL, "utf8");
    const parsed = parseJson(supabaseCli(["db", "query", "--linked", "--file", file, "-o", "json"], "db query"), "db query") as {
      rows?: { facts?: PreflightFacts }[];
    };
    const facts = parsed.rows?.[0]?.facts;
    if (!facts) throw new Error("Resposta do preflight sem dados.");
    return facts;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export { IMPORT_IDENTITY };
