import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CANONICAL_EXPECTATIONS, CANONICAL_WORKBOOK_PATH } from "./expectations";
import {
  APPLY_CONFIRMATION,
  CANONICAL_APPLY_INVARIANTS,
  deriveApplyInvariants,
  invariantProblems,
  type BatchMeasurement,
  type StateMeasurement,
} from "./hosted-apply";
import { HOSTED_INVENTORY_BASELINE } from "./hosted-session";
import { buildImportPlan } from "./pipeline";

const PATH = CANONICAL_WORKBOOK_PATH;

const emptyState = (): StateMeasurement => ({
  counts: { ...HOSTED_INVENTORY_BASELINE },
  movementsByType: {},
  productStock: 0,
  totalStock: 0,
  statusCounts: { OUT_OF_STOCK: 0, REORDER: 0, OK: 0 },
  finalByCategory: {},
});

const okBatch = (): BatchMeasurement => ({
  batchRecords: { created: 35, already_present: 0 },
  batchMovements: 15,
  movementsNotByIdentity: 0,
  batchExecutedByIdentity: true,
});

const canonicalState = (): StateMeasurement => {
  const { counts, movementsByType, productStock, totalStock, statusCounts, finalByCategory } = structuredClone(CANONICAL_APPLY_INVARIANTS);
  return { counts, movementsByType, productStock, totalStock, statusCounts, finalByCategory };
};

describe("canonical APPLY invariants", () => {
  it("equal the pristine hosted baseline plus the canonical plan (5/3/12/15, 10×343 + net 2 = 345, 2/3/7)", () => {
    const result = buildImportPlan({ fileName: CANONICAL_EXPECTATIONS.fileName, bytes: readFileSync(PATH) });
    if (!result.ok) throw new Error("canonical plan invalid");
    expect(deriveApplyInvariants(emptyState(), result.plan)).toEqual(CANONICAL_APPLY_INVARIANTS);
  });

  it("are pinned to the demo dataset values", () => {
    expect(CANONICAL_APPLY_INVARIANTS).toMatchObject({
      counts: { auth_users: 2, profiles: 2, categories: 5, locations: 3, suppliers: 0, projects: 0, products: 12, stock_movements: 15, import_batches: 1, import_records: 35 },
      movementsByType: {
        OPENING_BALANCE: { count: 10, quantity: 343 },
        IN: { count: 2, quantity: 11 },
        OUT: { count: 1, quantity: 12 },
        ADJUSTMENT_IN: { count: 1, quantity: 5 },
        ADJUSTMENT_OUT: { count: 1, quantity: 2 },
      },
      productStock: 12,
      totalStock: 345,
      statusCounts: { OUT_OF_STOCK: 2, REORDER: 3, OK: 7 },
      batchRecords: { created: 35, already_present: 0 },
      batchMovements: 15,
    });
  });
});

describe("pre-COMMIT gate", () => {
  it("passes only on the exact state (key order irrelevant)", () => {
    const state = canonicalState();
    state.finalByCategory = Object.fromEntries(Object.entries(state.finalByCategory).reverse());
    expect(invariantProblems(state, okBatch(), CANONICAL_APPLY_INVARIANTS)).toEqual([]);
  });

  it.each<[string, (s: StateMeasurement, b: BatchMeasurement) => void, RegExp]>([
    ["one extra product", (s) => (s.counts.products = 13), /contagens/],
    ["a supplier", (s) => (s.counts.suppliers = 1), /contagens/],
    ["second batch", (s) => (s.counts.import_batches = 2), /contagens/],
    ["opening quantity", (s) => (s.movementsByType.OPENING_BALANCE.quantity = 342), /movimentos por tipo/],
    ["missing movement type", (s) => delete s.movementsByType.ADJUSTMENT_OUT, /movimentos por tipo/],
    ["total stock", (s) => (s.totalStock = 344), /estoque total/],
    ["product_stock rows", (s) => (s.productStock = 11), /product_stock/],
    ["status split", (s) => ((s.statusCounts.REORDER = 2), (s.statusCounts.OK = 8)), /estados/],
    ["category total", (s) => (s.finalByCategory.Inverters = 7), /totais por categoria/],
    ["batch records", (_s, b) => (b.batchRecords = { created: 34, already_present: 1 }), /registos do batch/],
    ["movement not by the technical identity", (_s, b) => (b.movementsNotByIdentity = 1), /fora da identidade/],
    ["batch executed by someone else", (_s, b) => (b.batchExecutedByIdentity = false), /executed_by/],
  ])("%s → blocks the COMMIT", (_label, mutate, expected) => {
    const state = canonicalState();
    const batch = okBatch();
    mutate(state, batch);
    expect(invariantProblems(state, batch, CANONICAL_APPLY_INVARIANTS).join(" | ")).toMatch(expected);
  });
});

describe("persistence exists only in the APPLY module", () => {
  const noCommit = [
    "scripts/inventory-import/hosted-session.ts",
    "scripts/inventory-import/hosted-dry-run.ts",
    "scripts/inventory-import-hosted-dry-run.ts",
  ];

  it("shared and dry-run code never issue COMMIT", () => {
    for (const file of noCommit) expect(readFileSync(file, "utf8"), file).not.toMatch(/\bcommit\b/i);
  });

  it("the apply module has exactly one COMMIT, after the invariant gate", () => {
    const source = readFileSync("scripts/inventory-import/hosted-apply.ts", "utf8");
    expect(source.match(/client\.query\("commit"\)/g)).toHaveLength(1);
    expect(source.indexOf('refuse("invariantes pré-COMMIT"')).toBeGreaterThan(0);
    expect(source.indexOf('client.query("commit")')).toBeGreaterThan(source.indexOf('refuse("invariantes pré-COMMIT"'));
    expect(source).not.toContain("runImport");
    expect(source).toMatch(/if \(phase === "open"\) await client\.query\("rollback"\)/);
  });

  it("the confirmation token cannot be mistaken for a dry-run argument", () => {
    expect(APPLY_CONFIRMATION).toBe("IMPORT-345-UNITS");
    expect(readFileSync("scripts/inventory-import-hosted-dry-run.ts", "utf8")).not.toContain("confirm-apply");
  });
});

describe("hosted CLIs refuse before connecting", () => {
  const REF = "testprojectrefabcdef";
  const SHA = CANONICAL_EXPECTATIONS.sha256;
  const URL_OK = `postgresql://postgres:Pw-Fixture-123@db.${REF}.supabase.co:5432/postgres`;
  const dir = mkdtempSync(join(tmpdir(), "tralyn-apply-cli-"));
  const ca = join(dir, "ca.crt");
  writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const base = [`--file=${PATH}`, `--confirm-project=${REF}`, `--confirm-sha256=${SHA}`];
  const full = [...base, `--confirm-apply=${APPLY_CONFIRMATION}`];
  const run = (script: string, args: string[], env: Record<string, string | undefined>) => {
    const childEnv: Record<string, string | undefined> = {
      ...process.env,
      SUPABASE_PROJECT_REF: REF,
      INVENTORY_HOSTED_DATABASE_URL: undefined,
      INVENTORY_HOSTED_DATABASE_CA_FILE: undefined,
      ...env,
    };
    for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
    return spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", script, ...args], { encoding: "utf8", env: childEnv as NodeJS.ProcessEnv, timeout: 60_000 });
  };
  const withTarget = { INVENTORY_HOSTED_DATABASE_URL: URL_OK, INVENTORY_HOSTED_DATABASE_CA_FILE: ca };

  it.each<[string, string[], Record<string, string | undefined>]>([
    ["no arguments", [], {}],
    ["A: missing --confirm-apply", base, withTarget],
    ["A: wrong --confirm-apply", [...base, "--confirm-apply=yes"], withTarget],
    ["A: dry-run style token", [...base, "--confirm-apply=dry-run"], withTarget],
    ["B: wrong project confirmation", [full[0], "--confirm-project=otherprojectrefabcdef", full[2], full[3]], withTarget],
    ["C: wrong SHA confirmation", [full[0], full[1], `--confirm-sha256=${"0".repeat(64)}`, full[3]], withTarget],
    ["unknown flag", [...full, "--force"], withTarget],
    ["missing connection string", full, { INVENTORY_HOSTED_DATABASE_CA_FILE: ca }],
    ["another Supabase project", full, { ...withTarget, INVENTORY_HOSTED_DATABASE_URL: URL_OK.replace(REF, "otherprojectrefabcdef") }],
    ["local database", full, { ...withTarget, INVENTORY_HOSTED_DATABASE_URL: "postgresql://postgres:Pw-Fixture-123@127.0.0.1:54322/postgres" }],
    ["missing CA certificate", full, { INVENTORY_HOSTED_DATABASE_URL: URL_OK }],
    ["missing SUPABASE_PROJECT_REF", full, { ...withTarget, SUPABASE_PROJECT_REF: undefined }],
    ["malformed SUPABASE_PROJECT_REF", full, { ...withTarget, SUPABASE_PROJECT_REF: "not-a-ref" }],
  ])("apply CLI — %s → exit 2, nothing secret printed (L)", (_label, args, env) => {
    const result = run("scripts/inventory-import-hosted-apply.ts", args, env);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^(RECUSADO|Uso)/);
    expect(result.stdout + result.stderr).not.toContain("Pw-Fixture-123");
    expect(result.stdout + result.stderr).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("K: the dry-run CLI rejects the APPLY confirmation (cannot be turned into an APPLY)", () => {
    const result = run("scripts/inventory-import-hosted-dry-run.ts", full, withTarget);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/^RECUSADO/);
    expect(result.stdout).toBe("");
  });
});
