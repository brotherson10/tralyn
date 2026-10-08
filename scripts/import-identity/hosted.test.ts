import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertLocalTarget, IMPORT_IDENTITY, TargetNotAllowedError } from "./identity";
import {
  assertHostedTarget,
  confirmationProblems,
  evaluatePreflight,
  HOSTED_BASELINE,
  HOSTED_PROJECT_REF_ENV,
  hostedProjectFromEnv,
  hostedProjectFromRef,
  HostedTargetError,
  linkedProjectProblems,
  parseArgs,
  PREFLIGHT_SQL,
  redactSecrets,
  REQUIRED_FOREIGN_KEYS,
  type PreflightFacts,
} from "./hosted";
import { checkExitCode, type CheckReport } from "./hosted-runtime";
import { TEST_HOSTED_PROJECT as PROJECT } from "./test-project";

const NOW = new Date("2026-10-05T12:00:00Z");
const ADMIN = "11111111-1111-4111-8111-111111111111";
const TECH = "22222222-2222-4222-8222-222222222222";
const inYears = (y: number) => new Date(NOW.getTime() + y * 365 * 24 * 3600 * 1000).toISOString();

const baseFacts = (): PreflightFacts => ({
  auth_user_ids: [ADMIN],
  profiles: 1,
  identity_users: [],
  identity_profiles: [],
  counts: { import_batches: 0, import_records: 0, products: 0, stock_movements: 0 },
  foreign_keys: Object.entries(REQUIRED_FOREIGN_KEYS).map(([name, definition]) => ({ name, definition })),
  trigger_enabled: true,
  trigger_creates_viewer: true,
  profiles_role_default: "'viewer'::app_role",
});

const withIdentity = (): PreflightFacts => ({
  ...baseFacts(),
  auth_user_ids: [ADMIN, TECH],
  profiles: 2,
  identity_users: [
    {
      id: TECH,
      email: IMPORT_IDENTITY.email,
      email_confirmed_at: inYears(0),
      banned_until: inYears(100),
      last_sign_in_at: null,
      deleted_at: null,
      is_anonymous: false,
      app_metadata: { provider: "email", system_identity: "tralyn-import" },
    },
  ],
  identity_profiles: [{ id: TECH, name: "Importação de dados", role: "viewer", active: false }],
});

describe("hosted target guard", () => {
  it("accepts exactly the canonical project URL", () => {
    expect(() => assertHostedTarget(PROJECT.url, PROJECT)).not.toThrow();
    expect(() => assertHostedTarget(`${PROJECT.url}/`, PROJECT)).not.toThrow();
  });

  it.each([
    "http://127.0.0.1:54321",
    "http://localhost:54321",
    "https://otherprojectrefxyz.supabase.co",
    "https://testprojectrefabcdef.supabase.co.evil.example",
    "https://evil.example/testprojectrefabcdef.supabase.co",
    "http://testprojectrefabcdef.supabase.co",
    "https://testprojectrefabcdef.supabase.co:8443",
    "https://user:pass@testprojectrefabcdef.supabase.co",
    "https://testprojectrefabcdef.supabase.co/rest/v1",
    "https://testprojectrefabcdef.supabase.co/?x=1",
    "https://xtestprojectrefabcdef.supabase.co",
    "not a url",
  ])("refuses %s (including the local stack)", (url) => {
    expect(() => assertHostedTarget(url, PROJECT)).toThrow(HostedTargetError);
  });

  it("the local tool still refuses the hosted project", () => {
    expect(() => assertLocalTarget(PROJECT.url)).toThrow(TargetNotAllowedError);
  });
});

describe("hosted project configuration", () => {
  it("binds the project from SUPABASE_PROJECT_REF (url derived from the ref)", () => {
    expect(HOSTED_PROJECT_REF_ENV).toBe("SUPABASE_PROJECT_REF");
    expect(hostedProjectFromEnv({ SUPABASE_PROJECT_REF: " testprojectrefabcdef " })).toEqual({
      ref: "testprojectrefabcdef",
      name: "tralyn",
      url: "https://testprojectrefabcdef.supabase.co",
    });
  });

  it.each([
    ["missing", {}],
    ["empty", { SUPABASE_PROJECT_REF: "  " }],
  ])("fails fast when the variable is %s (no default, no fallback)", (_label, env) => {
    expect(() => hostedProjectFromEnv(env)).toThrow(/SUPABASE_PROJECT_REF não definida/);
  });

  it.each(["short", "TESTPROJECTREFABCDEF", "testprojectrefabcde1", "testprojectrefabcdefg", "https://testprojectrefabcdef.supabase.co"])(
    "refuses the malformed ref %s",
    (ref) => {
      expect(() => hostedProjectFromRef(ref)).toThrow(HostedTargetError);
      expect(() => hostedProjectFromEnv({ SUPABASE_PROJECT_REF: ref })).toThrow(HostedTargetError);
    },
  );
});

describe("linked project", () => {
  const ok = { linkedRefFile: PROJECT.ref, projects: [{ ref: PROJECT.ref, name: PROJECT.name, status: "ACTIVE_HEALTHY", linked: true }] };

  it("accepts the expected linked, healthy project", () => {
    expect(linkedProjectProblems(ok, PROJECT)).toEqual([]);
  });

  it("refuses another linked project, a missing link, a renamed or unhealthy project", () => {
    expect(linkedProjectProblems({ ...ok, linkedRefFile: "otherref" }, PROJECT).length).toBeGreaterThan(0);
    expect(linkedProjectProblems({ ...ok, linkedRefFile: null }, PROJECT).length).toBeGreaterThan(0);
    expect(linkedProjectProblems({ ...ok, projects: [{ ...ok.projects[0], linked: false }, { ref: "otherref", name: "x", status: "ACTIVE_HEALTHY", linked: true }] }, PROJECT).length).toBeGreaterThan(0);
    expect(linkedProjectProblems({ ...ok, projects: [{ ...ok.projects[0], name: "outro" }] }, PROJECT)).toEqual([expect.stringMatching(/nome do projeto/)]);
    expect(linkedProjectProblems({ ...ok, projects: [{ ...ok.projects[0], status: "PAUSED" }] }, PROJECT)).toEqual([expect.stringMatching(/PAUSED/)]);
  });
});

describe("APPLY confirmation", () => {
  const good = [`--confirm-project=${PROJECT.ref}`, `--confirm-identity=${IMPORT_IDENTITY.email}`];

  it("requires both exact confirmations", () => {
    expect(confirmationProblems(parseArgs(["apply", ...good]).confirmation, PROJECT)).toEqual([]);
    expect(confirmationProblems(parseArgs(["apply"]).confirmation, PROJECT)).toHaveLength(2);
    expect(confirmationProblems(parseArgs(["apply", good[0]]).confirmation, PROJECT)).toHaveLength(1);
    expect(confirmationProblems(parseArgs(["apply", "--confirm-project=otherref", good[1]]).confirmation, PROJECT)).toHaveLength(1);
    expect(confirmationProblems(parseArgs(["apply", good[0], "--confirm-identity=outro@x.invalid"]).confirmation, PROJECT)).toHaveLength(1);
    expect(confirmationProblems(parseArgs(["apply", `--confirm-project=${PROJECT.ref.toUpperCase()}`, good[1]]).confirmation, PROJECT)).toHaveLength(1);
  });

  it("reports unknown options (no --force/--url/--key escape hatches)", () => {
    expect(parseArgs(["apply", ...good, "--force", "--url=http://x", "--key=sb_secret_x"]).unknown).toEqual(["--force", "--url", "--key"]);
  });
});

describe("evaluatePreflight", () => {
  it("baseline with no identity → ready_to_create", () => {
    expect(evaluatePreflight(baseFacts(), HOSTED_BASELINE, NOW)).toEqual({ state: "ready_to_create", problems: [] });
  });

  it("canonical identity present → already_present", () => {
    expect(evaluatePreflight(withIdentity(), HOSTED_BASELINE, NOW)).toEqual({ state: "already_present", problems: [] });
  });

  it.each<[string, (f: PreflightFacts) => void, RegExp]>([
    ["extra auth user", (f) => f.auth_user_ids.push("33333333-3333-4333-8333-333333333333"), /auth.users = 2/],
    ["extra profile", (f) => (f.profiles = 2), /profiles = 2/],
    ["products not empty", (f) => (f.counts.products = 1), /products = 1/],
    ["movements not empty", (f) => (f.counts.stock_movements = 3), /stock_movements = 3/],
    ["import batch exists", (f) => (f.counts.import_batches = 1), /import_batches = 1/],
    ["stray technical profile", (f) => f.identity_profiles.push({ id: ADMIN, name: "Importação de dados", role: "viewer", active: false }), /fora da identidade/],
    ["FK cascade instead of restrict", (f) => (f.foreign_keys[1].definition = f.foreign_keys[1].definition.replace("RESTRICT", "CASCADE")), /alterada/],
    ["FK missing", (f) => f.foreign_keys.pop(), /em falta/],
    ["trigger disabled", (f) => (f.trigger_enabled = false), /trigger/],
    ["trigger no longer creates viewer", (f) => (f.trigger_creates_viewer = false), /viewer/],
    ["role default changed", (f) => (f.profiles_role_default = "'admin'::app_role"), /default/],
  ])("before creation: %s → fails", (_label, mutate, expected) => {
    const facts = baseFacts();
    mutate(facts);
    const result = evaluatePreflight(facts, HOSTED_BASELINE, NOW);
    expect(result.state).toBeNull();
    expect(result.problems.join(" | ")).toMatch(expected);
  });

  it.each<[string, (f: PreflightFacts) => void, RegExp]>([
    ["active = true", (f) => (f.identity_profiles[0].active = true), /active/],
    ["role admin", (f) => (f.identity_profiles[0].role = "admin"), /role/],
    ["role operator", (f) => (f.identity_profiles[0].role = "operator"), /role/],
    ["missing marker", (f) => (f.identity_users[0].app_metadata = { provider: "email" }), /marcador/],
    ["short ban", (f) => (f.identity_users[0].banned_until = inYears(5)), /banimento/],
    ["no ban", (f) => (f.identity_users[0].banned_until = null), /não bloqueada/],
    ["signed in once", (f) => (f.identity_users[0].last_sign_in_at = inYears(0)), /sessão/],
    ["profile missing (partial state)", (f) => (f.identity_profiles = []), /profile inexistente/],
    ["two identities", (f) => f.identity_users.push({ ...f.identity_users[0], id: ADMIN }), /encontrados 2/],
    ["another user created alongside", (f) => f.auth_user_ids.push("33333333-3333-4333-8333-333333333333"), /auth.users = 3/],
    ["profile count off", (f) => (f.profiles = 3), /profiles = 3/],
  ])("identity present but divergent: %s → fails", (_label, mutate, expected) => {
    const facts = withIdentity();
    mutate(facts);
    const result = evaluatePreflight(facts, HOSTED_BASELINE, NOW);
    expect(result.state).toBeNull();
    expect(result.problems.join(" | ")).toMatch(expected);
  });
});

describe("preflight SQL and output hygiene", () => {
  it("is a single read-only SELECT", () => {
    expect(PREFLIGHT_SQL.trim().toLowerCase().startsWith("select")).toBe(true);
    expect(PREFLIGHT_SQL).not.toMatch(/;\s*\S/);
    expect(PREFLIGHT_SQL).not.toMatch(/\b(insert|update|delete|truncate|alter|drop|create|grant|revoke)\b/i);
  });

  it("masks the provided key, Supabase keys, JWTs and DB passwords", () => {
    const key = "sb_secret_FIXTURE_REALVALUE";
    const text = `falhou com ${key}; outro sb_secret_abcdefgh; anon eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl; db postgres://postgres:hunter2@db.example:5432/postgres`;
    const out = redactSecrets(text, [key]);
    expect(out).not.toContain("REALVALUE");
    expect(out).not.toContain("abcdefgh");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[REDACTED]");
  });
});

describe("CLI exit code", () => {
  const report = (ok: boolean, state: CheckReport["state"]): CheckReport => ({
    ok,
    state,
    keyCheck: "ok",
    problems: ok ? [] : ["x"],
    authUsers: 1,
    profiles: 1,
    counts: {},
  });

  it("valid CHECK → 0; invalid CHECK → non-zero", () => {
    expect(checkExitCode(report(true, "ready_to_create"))).toBe(0);
    expect(checkExitCode(report(true, "already_present"))).toBe(0);
    expect(checkExitCode(report(false, null))).toBe(1);
    expect(checkExitCode(report(true, null))).toBe(1);
  });

  it("the hosted flow never calls process.exit()", () => {
    for (const file of ["scripts/hosted-import-identity.ts", "scripts/import-identity/hosted-runtime.ts", "scripts/import-identity/hosted.ts"]) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.exit\s*\(/);
    }
  });

  it.each([[["check", "--force"]], [["bogus"]], [[]]])("invalid arguments %j → exit 2 before any I/O", (args) => {
    const env = { ...process.env };
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    const run = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/hosted-import-identity.ts", ...args], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^Uso:/);
  });

  it.each([[undefined], ["not-a-ref"]])("SUPABASE_PROJECT_REF=%s → refused (exit 2) before any I/O", (ref) => {
    const env = { ...process.env };
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    delete env.SUPABASE_PROJECT_REF;
    if (ref !== undefined) env.SUPABASE_PROJECT_REF = ref;
    const run = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/hosted-import-identity.ts", "check"], {
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^RECUSADO — Alvo remoto recusado: .*SUPABASE_PROJECT_REF|^RECUSADO — Alvo remoto recusado: project ref inválido/);
  });
});
