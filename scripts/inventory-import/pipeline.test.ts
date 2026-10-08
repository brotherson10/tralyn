import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";
import { CANONICAL_EXPECTATIONS, SHEETS } from "./expectations";
import type { NormalizedHistoricalMovement, PipelineResult } from "./model";
import { buildImportPlan, sha256Hex } from "./pipeline";
import { movementFingerprint, movementReferences, referenceSlug } from "./plan";
import { buildFixture, DAY, type FixtureSheets } from "./test-fixture";

const run = (fixture: ReturnType<typeof buildFixture>) =>
  buildImportPlan({ fileName: fixture.fileName, bytes: fixture.bytes }, fixture.expectations);

const errorCodes = (result: PipelineResult) => (result.ok ? [] : result.errors.map((e) => e.code));

/** Mutates one cell of a data row (row 1 = first row after the header). */
const setCell = (sheet: string, row: number, header: string, value: string | number | null) => (sheets: FixtureSheets) => {
  const col = sheets[sheet][0].indexOf(header);
  if (col < 0) throw new Error(`no header ${header}`);
  sheets[sheet][row][col] = value;
};

describe("valid synthetic workbook", () => {
  it("produces a complete plan", () => {
    const result = run(buildFixture());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.reconciliation).toMatchObject({
      categories: 2,
      locations: 1,
      suppliers: 0,
      products: 3,
      openingBalances: 2,
      openingQuantity: 5,
      historicalMovements: 1,
      historicalNet: 1,
      finalQuantity: 6,
    });
    expect(result.warnings.map((w) => w.code)).toEqual(["LOCATION_EXCLUDED"]);
    expect(result.parsed.ignoredSheets).toEqual(["UTILIZADORES", "DASHBOARD"]);
  });

  it("is deterministic: the same bytes give an identical plan", () => {
    const fixture = buildFixture();
    expect(JSON.stringify(run(fixture))).toBe(JSON.stringify(run(fixture)));
  });

  it("keeps the legacy responsible as provenance only, never as a user", () => {
    const result = run(buildFixture());
    if (!result.ok) throw new Error("expected ok");
    const movement = result.plan.movements.find((m) => m.kind === "historical")!;
    expect(movement).not.toHaveProperty("responsible");
    expect(movement).not.toHaveProperty("userId");
    const record = result.plan.records.find((r) => r.sourceReference === movement.sourceReference)!;
    expect(record.sourceData).toMatchObject({ responsible: "Pessoa Teste", type: "Entrada", quantity: 1, date: "2026-07-28", sheet: SHEETS.movements, row: 2 });
    expect(result.plan.executedByEmail).toBe("importacao@tralyn.invalid");
  });

  it("interprets workbook dates as Lisbon calendar days", () => {
    const result = run(buildFixture());
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.movements.every((m) => m.createdAt === "2026-07-27T23:00:00.000Z")).toBe(true);
    expect(result.plan.products.every((p) => p.createdAt === "2026-07-27T23:00:00.000Z" && p.qrCode === null)).toBe(true);
  });

  it("product without model stays model = null (brand satisfies the constraint)", () => {
    const result = run(buildFixture());
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.products.find((p) => p.code === "CTA-002")).toMatchObject({ brand: "Marca Y", model: null });
  });

  it("a product with zero initial stock gets no OPENING_BALANCE", () => {
    const result = run(buildFixture());
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.movements.filter((m) => m.productCode === "CTB-001").map((m) => m.type)).toEqual(["IN"]);
    expect(result.plan.movements.filter((m) => m.type === "OPENING_BALANCE").every((m) => m.quantity > 0)).toBe(true);
  });
});

describe("file identity (fail-closed before parsing)", () => {
  it("rejects a different file name", () => {
    const fixture = buildFixture();
    const result = buildImportPlan({ fileName: "outro.xlsx", bytes: fixture.bytes }, fixture.expectations);
    expect(errorCodes(result)).toEqual(["FILE_NAME_MISMATCH"]);
    expect(result.parsed).toBeNull();
  });

  it("rejects a different SHA-256", () => {
    const fixture = buildFixture(undefined, { expectations: (e) => (e.sha256 = "0".repeat(64)) });
    expect(errorCodes(run(fixture))).toEqual(["FILE_HASH_MISMATCH"]);
  });

  it("canonical expectations reject any other file", () => {
    const fixture = buildFixture();
    const result = buildImportPlan({ fileName: CANONICAL_EXPECTATIONS.fileName, bytes: fixture.bytes });
    expect(errorCodes(result)).toEqual(["FILE_HASH_MISMATCH"]);
  });

  it("rejects bytes that are not a workbook", () => {
    const bytes = new TextEncoder().encode("isto não é um xlsx");
    const fixture = buildFixture();
    fixture.expectations.sha256 = sha256Hex(bytes);
    const result = buildImportPlan({ fileName: fixture.fileName, bytes }, fixture.expectations);
    expect(result.ok).toBe(false);
  });
});

describe("structure", () => {
  it("missing required sheet", () => {
    expect(errorCodes(run(buildFixture((s) => delete s[SHEETS.products])))).toContain("SHEET_MISSING");
  });

  it("changed header", () => {
    expect(errorCodes(run(buildFixture((s) => (s[SHEETS.products][0][6] = "Stock Inicial"))))).toContain("HEADER_UNEXPECTED");
  });

  it("extra header column", () => {
    expect(errorCodes(run(buildFixture((s) => s[SHEETS.categories][0].push("Extra"))))).toContain("HEADER_UNEXPECTED");
  });

  it("formula in a data column", () => {
    const patch = (wb: XLSX.WorkBook) => (wb.Sheets[SHEETS.products]["G2"] = { t: "n", v: 3, f: "1+2" });
    expect(errorCodes(run(buildFixture(undefined, { patch })))).toContain("FORMULA_IN_DATA_COLUMN");
  });

  it("Excel error value in a data cell", () => {
    const patch = (wb: XLSX.WorkBook) => (wb.Sheets[SHEETS.products]["C2"] = { t: "e", v: 15 });
    expect(errorCodes(run(buildFixture(undefined, { patch })))).toContain("CELL_ERROR");
  });

  it("suppliers sheet with data is not supported", () => {
    expect(errorCodes(run(buildFixture((s) => (s.FORNECEDORES = [["Nome"], ["Fornecedor Teste"]]))))).toContain("UNSUPPORTED_SHEET_DATA");
  });
});

describe("business rules", () => {
  it.each<[string, (s: FixtureSheets) => void, string]>([
    ["unknown category", setCell(SHEETS.products, 1, "Categoria", "Categoria Z"), "CATEGORY_UNKNOWN"],
    ["code prefix differs from category", setCell(SHEETS.products, 1, "Categoria", "Categoria B"), "PRODUCT_CODE_PREFIX_MISMATCH"],
    ["unknown location", setCell(SHEETS.products, 1, "Localização", "Depósito 2"), "LOCATION_UNKNOWN"],
    ["product on the example location", setCell(SHEETS.products, 1, "Localização", "X-01-01"), "LOCATION_EXCLUDED_REFERENCED"],
    ["unexpected location row", (s) => s[SHEETS.locations].push(["Z-09", null, null, null, null]), "LOCATION_UNEXPECTED"],
    ["duplicate product code", setCell(SHEETS.products, 2, "Código", "CTA-001"), "PRODUCT_DUPLICATE"],
    ["malformed product code", setCell(SHEETS.products, 1, "Código", "cta 1"), "PRODUCT_CODE_INVALID"],
    ["negative initial stock", setCell(SHEETS.products, 1, "Estoque Inicial", -1), "INITIAL_STOCK_NEGATIVE"],
    ["initial stock as text (no coercion)", setCell(SHEETS.products, 1, "Estoque Inicial", "3"), "INITIAL_STOCK_INVALID"],
    ["fractional initial stock", setCell(SHEETS.products, 1, "Estoque Inicial", 1.5), "INITIAL_STOCK_INVALID"],
    ["negative minimum stock", setCell(SHEETS.products, 1, "Estoque Mínimo", -1), "MINIMUM_STOCK_INVALID"],
    ["missing minimum stock", setCell(SHEETS.products, 1, "Estoque Mínimo", null), "MINIMUM_STOCK_INVALID"],
    ["no brand and no model", setCell(SHEETS.products, 2, "Marca", null), "PRODUCT_UNIDENTIFIED"],
    ["missing unit", setCell(SHEETS.products, 1, "Unidade", null), "PRODUCT_UNIT_MISSING"],
    ["invalid active flag", setCell(SHEETS.products, 1, "Ativo?", "Talvez"), "BOOLEAN_INVALID"],
    ["supplier given", setCell(SHEETS.products, 1, "Fornecedor Padrão", "Fornecedor Teste"), "SUPPLIER_UNSUPPORTED"],
    ["date with time", setCell(SHEETS.products, 1, "Data Cadastro Sistema", DAY + 0.5), "REGISTERED_ON_INVALID"],
    ["duplicate category", (s) => s[SHEETS.categories].push(["categoria a", "CTC", null]), "CATEGORY_DUPLICATE"],
    ["invalid category prefix", setCell(SHEETS.categories, 2, "Prefixo", "c-b"), "CATEGORY_PREFIX_INVALID"],
    ["movement for an unknown product", setCell(SHEETS.movements, 1, "Código", "CTZ-001"), "MOVEMENT_PRODUCT_UNKNOWN"],
    ["unknown movement type", setCell(SHEETS.movements, 1, "Tipo", "Transferência"), "MOVEMENT_TYPE_UNKNOWN"],
    ["non-positive entry", setCell(SHEETS.movements, 1, "Quantidade", 0), "MOVEMENT_QUANTITY_INVALID"],
    ["movement with project", setCell(SHEETS.movements, 1, "Projeto / Cliente", "Cliente Teste"), "PROJECT_UNSUPPORTED"],
    ["movement before registration", setCell(SHEETS.movements, 1, "Data", DAY - 1), "MOVEMENT_BEFORE_REGISTRATION"],
    ["workbook lookup disagrees", setCell(SHEETS.movements, 1, "Produto / Modelo", "Outro"), "WORKBOOK_LOOKUP_MISMATCH"],
    ["workbook current stock disagrees", setCell(SHEETS.products, 1, "Estoque Atual", 4), "WORKBOOK_STOCK_MISMATCH"],
  ])("%s → fails", (_label, mutate, code) => {
    const result = run(buildFixture(mutate));
    expect(result.ok).toBe(false);
    expect(errorCodes(result)).toContain(code);
  });

  it("outbound movement leading to a negative balance → fails", () => {
    const result = run(
      buildFixture((s) => {
        setCell(SHEETS.movements, 1, "Tipo", "Saída")(s);
        setCell(SHEETS.movements, 1, "Quantidade", 2)(s);
        setCell(SHEETS.products, 3, "Estoque Atual", -2)(s);
      }),
    );
    expect(errorCodes(result)).toContain("NEGATIVE_BALANCE");
  });

  it("legacy signed adjustments map to ADJUSTMENT_IN / ADJUSTMENT_OUT", () => {
    const result = run(
      buildFixture(
        (s) => {
          s[SHEETS.movements].push([DAY, "Ajuste", "CTA-001", "Categoria A", "Modelo 1", -2, null, null, null, null]);
          setCell(SHEETS.products, 1, "Estoque Atual", 1)(s);
        },
        { expectations: (e) => ((e.counts.historicalMovements = 2), (e.historicalNet = -1), (e.finalQuantity = 4)) },
      ),
    );
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.plan.movements.filter((m) => m.kind === "historical").map((m) => [m.type, m.quantity])).toEqual([
      ["IN", 1],
      ["ADJUSTMENT_OUT", 2],
    ]);
  });
});

describe("expectations (counts, totals, special products)", () => {
  it.each<[string, Parameters<typeof buildFixture>[1]]>([
    ["unexpected product count", { expectations: (e) => (e.counts.products = 4) }],
    ["unexpected opening count", { expectations: (e) => (e.counts.openingBalances = 3) }],
    ["unexpected opening total", { expectations: (e) => (e.openingQuantity = 6) }],
    ["unexpected final total", { expectations: (e) => (e.finalQuantity = 5) }],
    ["unexpected category total", { expectations: (e) => (e.initialByCategory["Categoria A"] = 4) }],
  ])("%s → fails", (_label, options) => {
    expect(errorCodes(run(buildFixture(undefined, options)))).toContain("EXPECTATION_MISMATCH");
  });

  it("special product without model receiving an invented model → fails", () => {
    expect(errorCodes(run(buildFixture(setCell(SHEETS.products, 2, "Modelo / Produto", "Inventado"))))).toContain("EXPECTATION_MISMATCH");
  });

  it("zero-stock special product receiving an initial stock → fails", () => {
    const result = run(
      buildFixture((s) => {
        setCell(SHEETS.products, 3, "Estoque Inicial", 1)(s);
        setCell(SHEETS.products, 3, "Estoque Atual", 2)(s);
      }),
    );
    expect(errorCodes(result)).toContain("EXPECTATION_MISMATCH");
  });

  it("historical movement of the special product changed → fails", () => {
    expect(errorCodes(run(buildFixture(setCell(SHEETS.movements, 1, "Responsável", "Outra Pessoa"))))).toContain("EXPECTATION_MISMATCH");
  });
});

describe("source references", () => {
  const movement = (over: Partial<NormalizedHistoricalMovement> = {}): NormalizedHistoricalMovement => ({
    date: "2026-07-28",
    legacyType: "Entrada",
    type: "IN",
    productCode: "CTB-001",
    quantity: 1,
    legacyQuantity: 1,
    responsible: "Pessoa Teste",
    project: null,
    document: null,
    notes: null,
    workbookCategory: null,
    workbookProduct: null,
    source: { sheet: SHEETS.movements, row: 2 },
    ...over,
  });

  it("entity references follow the agreed format", () => {
    const result = run(buildFixture());
    if (!result.ok) throw new Error("expected ok");
    expect(result.plan.records.map((r) => r.sourceReference)).toEqual([
      "tralyn-demo:category:CTA",
      "tralyn-demo:category:CTB",
      "tralyn-demo:location:DEPOSITO",
      "tralyn-demo:product:CTA-001",
      "tralyn-demo:product:CTA-002",
      "tralyn-demo:product:CTB-001",
      "tralyn-demo:opening:CTA-001",
      "tralyn-demo:opening:CTA-002",
      expect.stringMatching(/^tralyn-demo:movement:[0-9a-f]{16}-1$/),
    ]);
  });

  it("movement reference does not depend on the row number", () => {
    expect(movementFingerprint(movement({ source: { sheet: SHEETS.movements, row: 2 } }))).toBe(
      movementFingerprint(movement({ source: { sheet: SHEETS.movements, row: 900 } })),
    );
    expect(movementFingerprint(movement())).not.toBe(movementFingerprint(movement({ legacyQuantity: 2, quantity: 2 })));
  });

  it("identical movements get an occurrence counter", () => {
    const [a, b] = movementReferences([movement(), movement({ source: { sheet: SHEETS.movements, row: 3 } })]);
    expect(a.replace(/-1$/, "")).toBe(b.replace(/-2$/, ""));
    expect([a.slice(-2), b.slice(-2)]).toEqual(["-1", "-2"]);
  });

  it("a blank row before the movement keeps the same reference", () => {
    const plain = run(buildFixture());
    const shifted = run(buildFixture((s) => s[SHEETS.movements].splice(1, 0, [null, null, null, "", "", null, null, null, null, null])));
    if (!plain.ok || !shifted.ok) throw new Error("expected ok");
    const ref = (r: typeof plain) => (r.ok ? r.plan.movements.find((m) => m.kind === "historical")!.sourceReference : "");
    expect(ref(shifted)).toBe(ref(plain));
  });

  it("location slug is ASCII", () => {
    expect(referenceSlug("Pavilhão Norte")).toBe("PAVILHAO-NORTE");
    expect(referenceSlug("Depósito 2 / Zona B")).toBe("DEPOSITO-2-ZONA-B");
  });
});
