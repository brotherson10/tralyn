/**
 * Synthetic workbook for tests: same layout as the legacy file, fictional
 * data only (no business data). Built in memory; nothing is written to disk.
 */
import * as XLSX from "xlsx";
import {
  CATEGORY_COLUMNS,
  LOCATION_COLUMNS,
  MOVEMENT_COLUMNS,
  PRODUCT_COLUMNS,
  SHEETS,
  type ImportExpectations,
} from "./expectations";
import { sha256Hex } from "./pipeline";

export type Aoa = (string | number | boolean | null)[][];
export type FixtureSheets = Record<string, Aoa>;

/** Excel serial of 2026-07-28. */
export const DAY = 46231;

export function fixtureSheets(): FixtureSheets {
  return {
    [SHEETS.categories]: [
      CATEGORY_COLUMNS.map((c) => c.header),
      ["Categoria A", "CTA", "Descrição A"],
      ["Categoria B", "CTB", null],
    ],
    UTILIZADORES: [["Nome", "Perfil", "Ativo?", "Email"], ["Pessoa Teste", "Administrador", "Sim", null]],
    [SHEETS.locations]: [
      LOCATION_COLUMNS.map((c) => c.header),
      ["Depósito", "Geral", null, null, "Localização real"],
      ["X-01-01", "X", "01", "01", "Exemplo"],
    ],
    [SHEETS.products]: [
      PRODUCT_COLUMNS.map((c) => c.header),
      ["CTA-001", "Categoria A", "Marca X", "Modelo 1", "Spec 1", "un", 3, 1, "Depósito", null, "CTA-001", "Sim", DAY, null, 3, "OK"],
      ["CTA-002", "Categoria A", "Marca Y", null, null, "un", 2, 1, "Depósito", null, "CTA-002", "Sim", DAY, null, 2, "OK"],
      ["CTB-001", "Categoria B", "Marca Z", "Modelo 3", "Spec 3", "un", 0, 1, "Depósito", null, "CTB-001", "Sim", DAY, null, 1, "REPOR"],
    ],
    [SHEETS.movements]: [
      MOVEMENT_COLUMNS.map((c) => c.header),
      [DAY, "Entrada", "CTB-001", "Categoria B", "Modelo 3", 1, null, "Pessoa Teste", null, "Nota de teste"],
    ],
    DASHBOARD: [["Painel"], ["Indicador", 1]],
  };
}

export function fixtureExpectations(sha256: string): ImportExpectations {
  return {
    fileName: "teste.xlsx",
    sha256,
    realLocations: ["Depósito"],
    excludedLocations: [{ code: "X-01-01", reason: "linha de exemplo" }],
    counts: { categories: 2, locations: 1, suppliers: 0, products: 3, openingBalances: 2, historicalMovements: 1 },
    openingQuantity: 5,
    historicalNet: 1,
    finalQuantity: 6,
    initialByCategory: { "Categoria A": 5, "Categoria B": 0 },
    specialProducts: [
      {
        code: "CTB-001",
        initialStock: 0,
        noOpening: true,
        historical: [{ legacyType: "Entrada", quantity: 1, date: "2026-07-28", responsible: "Pessoa Teste" }],
      },
      { code: "CTA-002", brand: "Marca Y", model: null },
    ],
  };
}

export function toXlsx(sheets: FixtureSheets, patch?: (wb: XLSX.WorkBook) => void): Uint8Array {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  patch?.(wb);
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}

/**
 * Builds a (possibly mutated) synthetic workbook whose expectations match its
 * own hash, so tests reach the parsing/validation rules they target.
 */
export function buildFixture(
  mutate?: (sheets: FixtureSheets) => void,
  options: { patch?: (wb: XLSX.WorkBook) => void; expectations?: (e: ImportExpectations) => void } = {},
) {
  const sheets = fixtureSheets();
  mutate?.(sheets);
  const bytes = toXlsx(sheets, options.patch);
  const expectations = fixtureExpectations(sha256Hex(bytes));
  options.expectations?.(expectations);
  return { fileName: expectations.fileName, bytes, expectations };
}
