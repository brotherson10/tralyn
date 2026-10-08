import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CANONICAL_EXPECTATIONS, CANONICAL_WORKBOOK_PATH } from "./expectations";
import { assertHostedDatabaseUrl, HostedImportTargetError, readHostedCa } from "./hosted-target";
import { assertLocalDatabaseUrl, ImportTargetError } from "./target";

const REF = "testprojectrefabcdef";
const DIRECT = `postgresql://postgres:Pw-Fixture-123@db.${REF}.supabase.co:5432/postgres`;
const POOLER = `postgresql://postgres.${REF}:Pw-Fixture-123@aws-0-eu-west-2.pooler.supabase.com:5432/postgres`;

describe("hosted database target guard", () => {
  it("accepts the project's direct and session-pooler connections", () => {
    expect(assertHostedDatabaseUrl(DIRECT, REF)).toMatchObject({ kind: "direct", host: `db.${REF}.supabase.co`, port: 5432, user: "postgres" });
    expect(assertHostedDatabaseUrl(POOLER, REF)).toMatchObject({ kind: "session-pooler", user: `postgres.${REF}` });
    expect(assertHostedDatabaseUrl(POOLER.replace("aws-0-eu-west-2", "aws-1-us-east-1"), REF).kind).toBe("session-pooler");
  });

  it.each([
    [undefined, /não definida/],
    ["nonsense", /inválida/],
    ["mysql://postgres:x@db.testprojectrefabcdef.supabase.co:5432/postgres", /protocolo/],
    ["postgresql://postgres:x@db.otherprojectrefabcdef.supabase.co:5432/postgres", /não pertence/],
    ["postgresql://postgres:x@db.testprojectrefabcdef.supabase.co.evil.example:5432/postgres", /não pertence/],
    ["postgresql://postgres:x@testprojectrefabcdef.supabase.co:5432/postgres", /não pertence/],
    ["postgresql://postgres.otherprojectrefabcdef:x@aws-0-eu-west-2.pooler.supabase.com:5432/postgres", /pooler não pertence/],
    ["postgresql://postgres:x@aws-0-eu-west-2.pooler.supabase.com:5432/postgres", /pooler não pertence/],
    [POOLER.replace(":5432/", ":6543/"), /5432/],
    [DIRECT.replace(":5432/", ":6543/"), /5432/],
    ["postgresql://admin:x@db.testprojectrefabcdef.supabase.co:5432/postgres", /utilizador inesperado/],
    [DIRECT.replace(/\/postgres$/, "/outra"), /base de dados/],
    [`${DIRECT}?sslmode=disable`, /parâmetros/],
    [`${DIRECT}?host=127.0.0.1`, /parâmetros/],
    ["postgresql://postgres@db.testprojectrefabcdef.supabase.co:5432/postgres", /password em falta/],
    ["postgresql://postgres:postgres@127.0.0.1:54322/postgres", /não pertence/],
    ["postgresql://postgres:postgres@localhost:54322/postgres", /não pertence/],
  ])("refuses %s", (url, reason) => {
    let error: unknown;
    try {
      assertHostedDatabaseUrl(url, REF);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(HostedImportTargetError);
    expect((error as Error).message).toMatch(reason);
  });

  it("never echoes the password or connection string in errors", () => {
    for (const url of [DIRECT.replace(":5432/", ":6543/"), POOLER.replace(`postgres.${REF}`, "postgres.other")]) {
      try {
        assertHostedDatabaseUrl(url, REF);
      } catch (e) {
        expect((e as Error).message).not.toContain("Pw-Fixture-123");
        expect((e as Error).message).not.toContain(url);
      }
    }
  });

  it("requires a PEM CA certificate for verify-full TLS", () => {
    const dir = mkdtempSync(join(tmpdir(), "tralyn-ca-"));
    try {
      writeFileSync(join(dir, "ok.crt"), "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
      writeFileSync(join(dir, "bad.crt"), "not a certificate");
      expect(readHostedCa(join(dir, "ok.crt"))).toContain("BEGIN CERTIFICATE");
      expect(() => readHostedCa(undefined)).toThrow(/não definida/);
      expect(() => readHostedCa(join(dir, "missing.crt"))).toThrow(/ilegível/);
      expect(() => readHostedCa(join(dir, "bad.crt"))).toThrow(/PEM/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the LOCAL importer guard still refuses the hosted project", async () => {
    for (const url of [DIRECT, POOLER]) {
      await expect(assertLocalDatabaseUrl(url)).rejects.toBeInstanceOf(ImportTargetError);
    }
  });
});

describe("no route to persist on the hosted path", () => {
  const files = ["scripts/inventory-import/hosted-dry-run.ts", "scripts/inventory-import-hosted-dry-run.ts"];

  it("never issues COMMIT, never uses runImport, has no apply mode", () => {
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bcommit\b/i);
      expect(source, file).not.toMatch(/\bend\s+transaction\b/i);
      expect(source, file).not.toContain("runImport");
      expect(source, file).not.toMatch(/--apply|"apply"/);
    }
    // The dry-run transaction ends in an unconditional ROLLBACK.
    expect(readFileSync(files[0], "utf8")).toMatch(/finally \{\s*await client\.query\("rollback"\);/);
  });
});

describe("hosted dry-run CLI refuses before connecting", () => {
  const dir = mkdtempSync(join(tmpdir(), "tralyn-cli-"));
  const ca = join(dir, "ca.crt");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const SHA = CANONICAL_EXPECTATIONS.sha256;
  const ok = [`--file=${CANONICAL_WORKBOOK_PATH}`, `--confirm-project=${REF}`, `--confirm-sha256=${SHA}`];
  const cli = (args: string[], env: Record<string, string | undefined>) => {
    const childEnv: Record<string, string | undefined> = { ...process.env, SUPABASE_PROJECT_REF: REF, INVENTORY_HOSTED_DATABASE_URL: undefined, INVENTORY_HOSTED_DATABASE_CA_FILE: undefined, ...env };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    return spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/inventory-import-hosted-dry-run.ts", ...args], {
      encoding: "utf8",
      env: childEnv as NodeJS.ProcessEnv,
      timeout: 60_000,
    });
  };

  it.each([
    ["no arguments", [], {}],
    ["apply flag does not exist", [...ok, "--apply"], { INVENTORY_HOSTED_DATABASE_URL: DIRECT, INVENTORY_HOSTED_DATABASE_CA_FILE: ca }],
    ["wrong project confirmation", [ok[0], "--confirm-project=otherprojectrefabcdef", ok[2]], { INVENTORY_HOSTED_DATABASE_URL: DIRECT }],
    ["wrong SHA confirmation", [ok[0], ok[1], `--confirm-sha256=${"0".repeat(64)}`], { INVENTORY_HOSTED_DATABASE_URL: DIRECT }],
    ["missing confirmations", [ok[0]], { INVENTORY_HOSTED_DATABASE_URL: DIRECT }],
    ["missing connection string", ok, {}],
    ["another Supabase project", ok, { INVENTORY_HOSTED_DATABASE_URL: DIRECT.replace(REF, "otherprojectrefabcdef") }],
    ["local database", ok, { INVENTORY_HOSTED_DATABASE_URL: "postgresql://postgres:Pw-Fixture-123@127.0.0.1:54322/postgres" }],
    ["missing CA certificate", ok, { INVENTORY_HOSTED_DATABASE_URL: DIRECT }],
    ["missing SUPABASE_PROJECT_REF", ok, { SUPABASE_PROJECT_REF: undefined, INVENTORY_HOSTED_DATABASE_URL: DIRECT, INVENTORY_HOSTED_DATABASE_CA_FILE: ca }],
    ["malformed SUPABASE_PROJECT_REF", ok, { SUPABASE_PROJECT_REF: "not-a-ref", INVENTORY_HOSTED_DATABASE_URL: DIRECT, INVENTORY_HOSTED_DATABASE_CA_FILE: ca }],
  ])("%s → exit 2, nothing secret printed", (_label, args, env) => {
    const run = cli(args as string[], env as Record<string, string>);
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toMatch(/^(RECUSADO|Uso)/);
    expect(run.stdout + run.stderr).not.toContain("Pw-Fixture-123");
    expect(run.stdout + run.stderr).not.toMatch(/postgres(ql)?:\/\//);
  });
});
