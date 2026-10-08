/**
 * RAW → PARSED. Reads the workbook (SheetJS, which handles the prefixed OOXML
 * namespaces of the legacy file) and maps the four source sheets to named
 * columns. Headers must match exactly; nothing is coerced here.
 */
import * as XLSX from "xlsx";
import {
  CATEGORY_COLUMNS,
  LOCATION_COLUMNS,
  MOVEMENT_COLUMNS,
  PRODUCT_COLUMNS,
  SHEETS,
  UNSUPPORTED_DATA_SHEETS,
  type ColumnSpec,
} from "./expectations";
import type { ParsedRow, ParsedWorkbook, RawCell, RawRow, RawWorkbook, ValidationIssue } from "./model";

const CELL_TYPES = new Set(["s", "n", "b", "e", "d", "z"]);

export function readRawWorkbook(bytes: Uint8Array): RawWorkbook {
  const workbook = XLSX.read(bytes, { type: "buffer", cellFormula: true, cellDates: false, cellHTML: false, cellText: false });
  const sheets: RawWorkbook["sheets"] = {};
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    const rows: RawRow[] = [];
    if (sheet["!ref"]) {
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      for (let r = range.s.r; r <= range.e.r; r += 1) {
        const cells: (RawCell | null)[] = [];
        for (let c = 0; c <= range.e.c; c += 1) {
          const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
          if (!cell) {
            cells.push(null);
            continue;
          }
          const type = CELL_TYPES.has(cell.t) ? (cell.t as RawCell["type"]) : "z";
          const value = type === "e" ? String(cell.w ?? "#ERR") : type === "z" ? null : ((cell.v as RawCell["value"]) ?? null);
          cells.push({ type, value, formula: Boolean(cell.f) });
        }
        rows.push({ row: r + 1, cells });
      }
    }
    sheets[name] = { name, rows };
  }
  return { sheetNames: [...workbook.SheetNames], sheets, date1904: Boolean(workbook.Workbook?.WBProps?.date1904) };
}

/** A cell carries data when it is not missing/stub/empty text. Whitespace counts as data. */
export function isEmptyCell(cell: RawCell | null | undefined): boolean {
  return !cell || cell.type === "z" || cell.value === null || cell.value === "";
}

function parseSheet<F extends string>(
  raw: RawWorkbook,
  sheetName: string,
  columns: ColumnSpec<F>[],
  issues: ValidationIssue[],
): { rows: ParsedRow<F>[]; dataRows: number; usedRows: number } | null {
  const sheet = raw.sheets[sheetName];
  if (!sheet) {
    issues.push({ severity: "error", code: "SHEET_MISSING", message: `Folha obrigatória "${sheetName}" não encontrada.`, sheet: sheetName });
    return null;
  }
  const header = sheet.rows[0];
  if (!header || header.row !== 1) {
    issues.push({ severity: "error", code: "HEADER_MISSING", message: `Folha "${sheetName}" sem cabeçalho na linha 1.`, sheet: sheetName });
    return null;
  }
  let headerOk = true;
  const width = Math.max(columns.length, header.cells.length);
  for (let c = 0; c < width; c += 1) {
    const expected = columns[c]?.header ?? null;
    const cell = header.cells[c];
    const actual = isEmptyCell(cell) ? null : String(cell!.value);
    if (actual !== expected) {
      headerOk = false;
      issues.push({
        severity: "error",
        code: "HEADER_UNEXPECTED",
        message: `Cabeçalho inesperado na coluna ${XLSX.utils.encode_col(c)}: "${actual ?? ""}" (esperado "${expected ?? ""}").`,
        sheet: sheetName,
        row: 1,
        column: XLSX.utils.encode_col(c),
      });
    }
  }
  if (!headerOk) return null;

  const rows: ParsedRow<F>[] = [];
  for (const rawRow of sheet.rows.slice(1)) {
    const hasData = columns.some((col, c) => !col.derived && !isEmptyCell(rawRow.cells[c]));
    if (!hasData) continue;
    const fields = {} as Record<F, RawCell | null>;
    columns.forEach((col, c) => {
      const cell = rawRow.cells[c] ?? null;
      if (!col.derived && cell?.formula) {
        issues.push({
          severity: "error",
          code: "FORMULA_IN_DATA_COLUMN",
          message: `Fórmula numa coluna de dados ("${col.header}").`,
          sheet: sheetName,
          row: rawRow.row,
          column: XLSX.utils.encode_col(c),
        });
      }
      fields[col.field] = cell;
    });
    rows.push({ sheet: sheetName, row: rawRow.row, fields });
  }
  return { rows, dataRows: rows.length, usedRows: sheet.rows.length };
}

export function parseWorkbook(raw: RawWorkbook): { parsed: ParsedWorkbook | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (raw.date1904) {
    issues.push({ severity: "error", code: "DATE_SYSTEM_1904", message: "Workbook usa o sistema de datas 1904 (não suportado)." });
  }

  for (const name of UNSUPPORTED_DATA_SHEETS) {
    const sheet = raw.sheets[name];
    if (sheet && sheet.rows.slice(1).some((r) => r.cells.some((c) => !isEmptyCell(c)))) {
      issues.push({ severity: "error", code: "UNSUPPORTED_SHEET_DATA", message: `A folha "${name}" tem dados, não suportados nesta importação.`, sheet: name });
    }
  }

  const categories = parseSheet(raw, SHEETS.categories, CATEGORY_COLUMNS, issues);
  const locations = parseSheet(raw, SHEETS.locations, LOCATION_COLUMNS, issues);
  const products = parseSheet(raw, SHEETS.products, PRODUCT_COLUMNS, issues);
  const movements = parseSheet(raw, SHEETS.movements, MOVEMENT_COLUMNS, issues);
  if (!categories || !locations || !products || !movements) return { parsed: null, issues };

  const used = new Set<string>(Object.values(SHEETS));
  return {
    parsed: {
      sheetNames: raw.sheetNames,
      ignoredSheets: raw.sheetNames.filter((n) => !used.has(n)),
      categories: categories.rows,
      locations: locations.rows,
      products: products.rows,
      movements: movements.rows,
      rawCounts: {
        [SHEETS.categories]: { dataRows: categories.dataRows, usedRows: categories.usedRows },
        [SHEETS.locations]: { dataRows: locations.dataRows, usedRows: locations.usedRows },
        [SHEETS.products]: { dataRows: products.dataRows, usedRows: products.usedRows },
        [SHEETS.movements]: { dataRows: movements.dataRows, usedRows: movements.usedRows },
      },
    },
    issues,
  };
}
