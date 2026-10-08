import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { buildDemoWorkbook } from "./demo-workbook";
import { CANONICAL_EXPECTATIONS, CANONICAL_WORKBOOK_PATH, MOVEMENT_COLUMNS, PRODUCT_COLUMNS, SHEETS } from "./expectations";
import { CANONICAL_DB_EXPECTATIONS, expectedProductState } from "./importer";
import type { ImportPlan } from "./model";
import { buildImportPlan, sha256Hex } from "./pipeline";

/**
 * The canonical workbook is the versioned, fictional demo file, so these
 * tests always run (no private file is needed).
 */
const bytes = readFileSync(CANONICAL_WORKBOOK_PATH);

describe("demo workbook file", () => {
  it("is exactly what the fictional data module generates (byte-for-byte) and matches the pinned SHA-256", () => {
    expect(Buffer.from(buildDemoWorkbook()).equals(bytes)).toBe(true);
    expect(sha256Hex(bytes)).toBe(CANONICAL_EXPECTATIONS.sha256);
    expect(CANONICAL_WORKBOOK_PATH.endsWith(`/${CANONICAL_EXPECTATIONS.fileName}`)).toBe(true);
  });

  it("keeps the legacy format: sheets, derived formula columns, plain data columns, date serials", () => {
    const wb = XLSX.read(bytes, { type: "buffer", cellFormula: true });
    expect(wb.SheetNames).toEqual([SHEETS.categories, SHEETS.locations, "FORNECEDORES", "UTILIZADORES", SHEETS.products, SHEETS.movements, "DASHBOARD"]);
    const products = wb.Sheets[SHEETS.products];
    const movements = wb.Sheets[SHEETS.movements];
    const col = (columns: { field: string }[], field: string) => XLSX.utils.encode_col(columns.findIndex((c) => c.field === field));
    for (let r = 2; r <= 13; r += 1) {
      expect(products[`${col(PRODUCT_COLUMNS, "workbookCurrentStock")}${r}`].f).toMatch(/SUMIFS/);
      expect(products[`${col(PRODUCT_COLUMNS, "workbookStatus")}${r}`].f).toMatch(/^IF\(/);
      expect(products[`${col(PRODUCT_COLUMNS, "initialStock")}${r}`]).toMatchObject({ t: "n" });
      expect(products[`${col(PRODUCT_COLUMNS, "initialStock")}${r}`].f).toBeUndefined();
      expect(products[`${col(PRODUCT_COLUMNS, "registeredOn")}${r}`]).toMatchObject({ t: "n", v: 46083 });
    }
    for (let r = 2; r <= 6; r += 1) {
      expect(movements[`${col(MOVEMENT_COLUMNS, "category")}${r}`].f).toMatch(/^VLOOKUP/);
      expect(movements[`${col(MOVEMENT_COLUMNS, "date")}${r}`]).toMatchObject({ t: "n" });
    }
  });

  it("uses only the fictional brands, people and author of the demo dataset (allowlist)", () => {
    const wb = XLSX.read(bytes, { type: "buffer" });
    const rows = (sheet: string) => XLSX.utils.sheet_to_json<(string | number | null)[]>(wb.Sheets[sheet], { header: 1, defval: null }).slice(1);
    const brandColumn = PRODUCT_COLUMNS.findIndex((c) => c.field === "brand");
    const brands = new Set(rows(SHEETS.products).map((r) => (typeof r[brandColumn] === "string" ? r[brandColumn].trim() : r[brandColumn])));
    expect(brands).toEqual(new Set(["Sunvolt", "Voltaris", "Gridora", "Northgrid", null]));
    const responsibleColumn = MOVEMENT_COLUMNS.findIndex((c) => c.field === "responsible");
    expect(new Set(rows(SHEETS.movements).map((r) => r[responsibleColumn]))).toEqual(new Set(["Demo Operator"]));
    expect(rows("UTILIZADORES").map((r) => r[0])).toEqual(["Demo Operator"]);
    expect(rows("FORNECEDORES")).toEqual([]);
    expect(wb.Props).toMatchObject({ Author: "Tralyn", Title: "Tralyn demo inventory" });
  });
});

describe("demo workbook through the canonical pipeline", () => {
  const result = buildImportPlan({ fileName: CANONICAL_EXPECTATIONS.fileName, bytes });
  const plan = (result.ok ? result.plan : null) as ImportPlan;

  it("is accepted; the only warnings are the example location and two provenance-only fields", () => {
    expect(result.ok ? [] : result.errors).toEqual([]);
    expect(result.warnings.map((w) => [w.code, w.sheet, w.row])).toEqual([
      ["LOCATION_EXCLUDED", "LOCALIZAÇÕES", 5],
      ["NOTES_PROVENANCE_ONLY", "PRODUTOS", 9],
      ["LEGACY_QR_DIFFERS", "PRODUTOS", 13],
    ]);
  });

  it("reconciles to 5 / 3 / 0 / 12 / 10 / 343 / 5 / +2 / 345", () => {
    expect(plan.reconciliation).toMatchObject({
      categories: 5,
      locations: 3,
      suppliers: 0,
      products: 12,
      openingBalances: 10,
      openingQuantity: 343,
      historicalMovements: 5,
      historicalNet: 2,
      finalQuantity: 345,
    });
  });

  it("matches the expected totals per category (initial → final)", () => {
    expect(Object.fromEntries(plan.reconciliation.byCategory.map((c) => [c.name, [c.initial, c.final]]))).toEqual({
      "Solar Panels": [54, 48],
      Inverters: [3, 8],
      Batteries: [16, 14],
      "EV Chargers": [7, 7],
      "Mounting & Protection": [263, 268],
    });
  });

  it("imports the three real locations and never the template example row", () => {
    expect(plan.locations.map((l) => l.code)).toEqual(["WH-A-01", "RACK-B-02", "YARD-01"]);
    expect(new Set(plan.products.map((p) => p.locationCode))).toEqual(new Set(["WH-A-01", "RACK-B-02", "YARD-01"]));
    expect(JSON.stringify(plan)).not.toContain("Z-99-99");
  });

  it("opening balances: 10, all positive, sum 343, none for the zero-stock products", () => {
    const openings = plan.movements.filter((m) => m.type === "OPENING_BALANCE");
    expect(openings).toHaveLength(10);
    expect(openings.every((m) => m.quantity > 0 && m.sourceReference === `tralyn-demo:opening:${m.productCode}`)).toBe(true);
    expect(openings.every((m) => m.createdAt === "2026-03-02T00:00:00.000Z")).toBe(true);
    expect(openings.reduce((s, m) => s + m.quantity, 0)).toBe(343);
    expect(openings.some((m) => m.productCode === "INV-201" || m.productCode === "EVC-402")).toBe(false);
  });

  it("historical movements: IN, IN, OUT and both adjustment directions, at day start in Lisbon (WET and WEST)", () => {
    expect(plan.movements.filter((m) => m.kind === "historical").map((m) => [m.productCode, m.type, m.quantity, m.createdAt])).toEqual([
      ["PAN-101", "IN", 6, "2026-03-16T00:00:00.000Z"],
      ["INV-201", "IN", 5, "2026-04-14T23:00:00.000Z"],
      ["PAN-102", "OUT", 12, "2026-04-21T23:00:00.000Z"],
      ["BAT-302", "ADJUSTMENT_OUT", 2, "2026-05-05T23:00:00.000Z"],
      ["MNT-502", "ADJUSTMENT_IN", 5, "2026-05-05T23:00:00.000Z"],
    ]);
  });

  it("INV-201: in the 12 products, no opening, a single IN +5", () => {
    expect(plan.products.some((p) => p.code === "INV-201")).toBe(true);
    expect(plan.movements.filter((m) => m.productCode === "INV-201")).toEqual([
      expect.objectContaining({ type: "IN", quantity: 5, notes: "Demo stock receipt", kind: "historical" }),
    ]);
  });

  it("historical provenance keeps the legacy fields; the responsible person is never a user", () => {
    const historical = plan.movements.find((m) => m.productCode === "INV-201")!;
    const record = plan.records.find((r) => r.sourceReference === historical.sourceReference)!;
    expect(record).toMatchObject({ entityType: "stock_movement", sourceSheet: "MOVIMENTAÇÕES", sourceRow: 3 });
    expect(record.sourceData).toEqual({
      date: "2026-04-15",
      type: "Entrada",
      code: "INV-201",
      quantity: 5,
      responsible: "Demo Operator",
      project: null,
      document: null,
      notes: "Demo stock receipt",
      sheet: "MOVIMENTAÇÕES",
      row: 3,
    });
    expect(plan.executedByEmail).toBe("importacao@tralyn.invalid");
    expect(JSON.stringify(plan.movements)).not.toContain("Demo Operator");
    // A signed legacy "Ajuste" keeps its sign in provenance only.
    const adjustment = plan.movements.find((m) => m.productCode === "BAT-302" && m.kind === "historical")!;
    expect(plan.records.find((r) => r.sourceReference === adjustment.sourceReference)!.sourceData).toMatchObject({ type: "Ajuste", quantity: -2 });
  });

  it("optional brand/model: brand-only and model-only products keep NULL, never placeholder text", () => {
    expect(plan.products.filter((p) => p.brand === null || p.model === null).map((p) => [p.code, p.brand, p.model])).toEqual([
      ["EVC-401", "Northgrid", null],
      ["MNT-501", null, "Mounting Rail 4 m"],
      ["MNT-502", null, "Roof Hook"],
      ["MNT-504", null, "Connector Pair"],
    ]);
  });

  it("normalizes text: trimmed brand, NFC accents, blank optional field → NULL", () => {
    const byCode = (code: string) => plan.products.find((p) => p.code === code)!;
    expect(byCode("PAN-102").brand).toBe("Sunvolt");
    expect(byCode("MNT-502").specification).toBe("Aço inoxidável".normalize("NFC"));
    expect(byCode("MNT-502").specification!.normalize("NFC")).toBe(byCode("MNT-502").specification);
    expect(byCode("MNT-504").specification).toBeNull();
    expect(plan.categories.find((c) => c.prefix === "EVC")!.description).toBeNull();
  });

  it("keeps the legacy QR id and product notes only as provenance", () => {
    const record = (code: string) => plan.records.find((r) => r.sourceReference === `tralyn-demo:product:${code}`)!.sourceData;
    expect(record("MNT-504")).toMatchObject({ legacy_qr: "LEG-MNT-504" });
    expect(record("EVC-402")).toMatchObject({ notes: "Demo: awaiting first delivery" });
    expect(plan.products.every((p) => p.qrCode === null)).toBe(true);
  });

  it("final state: 7 OK / 3 REORDER / 2 OUT_OF_STOCK, no negative balance", () => {
    const state = expectedProductState(plan);
    const counts = { OUT_OF_STOCK: 0, REORDER: 0, OK: 0 };
    for (const p of state) counts[p.status] += 1;
    expect(counts).toEqual(CANONICAL_DB_EXPECTATIONS.statusCounts);
    expect(state.every((p) => p.balance >= 0)).toBe(true);
    expect(Object.fromEntries(state.map((p) => [p.code, p.balance]))).toMatchObject({ "BAT-302": 0, "EVC-402": 0, "INV-201": 5, "PAN-102": 6 });
  });

  it("products: unique codes, qr_code NULL, created_at = registration day in Lisbon", () => {
    expect(new Set(plan.products.map((p) => p.code)).size).toBe(12);
    expect(plan.products.every((p) => p.qrCode === null && p.createdAt === "2026-03-02T00:00:00.000Z")).toBe(true);
  });

  it("source references are unique and stable across runs", () => {
    const again = buildImportPlan({ fileName: CANONICAL_EXPECTATIONS.fileName, bytes });
    expect(again.ok && JSON.stringify(again.plan)).toBe(JSON.stringify(plan));
    const refs = plan.records.map((r) => `${r.entityType}|${r.sourceReference}`);
    expect(new Set(refs).size).toBe(refs.length);
    expect(plan.records).toHaveLength(5 + 3 + 12 + 10 + 5);
  });

  it("a renamed copy or a single changed byte is refused", () => {
    expect(buildImportPlan({ fileName: "tralyn-demo (1).xlsx", bytes }).ok).toBe(false);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 1] ^= 0xff;
    const tamperedResult = buildImportPlan({ fileName: CANONICAL_EXPECTATIONS.fileName, bytes: tampered });
    expect(tamperedResult.ok ? [] : tamperedResult.errors.map((e) => e.code)).toEqual(["FILE_HASH_MISMATCH"]);
  });
});

describe("inventory:parse CLI", () => {
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/inventory-parse.ts", ...args], { encoding: "utf8", timeout: 60_000 });

  it("without a path → exit 2", () => {
    const run = cli();
    expect(run.status).toBe(2);
    expect(run.stdout).toBe("");
  });

  it("demo file → exit 0 and a summary without the workbook rows", () => {
    const run = cli(CANONICAL_WORKBOOK_PATH);
    expect(run.status).toBe(0);
    const summary = JSON.parse(run.stdout);
    expect(summary).toMatchObject({ valid: true, file: { sha256: CANONICAL_EXPECTATIONS.sha256 }, reconciliation: { finalQuantity: 345 } });
    expect(Object.keys(summary.plan.specialProducts)).toEqual(["INV-201", "EVC-401"]);
    // Only aggregate data (and issue messages): product rows are not printed.
    expect(run.stdout).not.toContain("GD-DC1000");
    expect(run.stdout).not.toContain("Aluminium");
    expect(run.stdout).not.toContain(process.cwd());
  });
});
