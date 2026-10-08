/**
 * Data model of the legacy inventory import, one type per pipeline stage:
 *
 *   RAW EXCEL → PARSED → NORMALIZED → VALIDATED → IMPORT PLAN
 *
 * Nothing in this pipeline touches a database: the ImportPlan is a pure,
 * deterministic description of what a future importer would write.
 */
import type { MovementType } from "@/lib/stock/ledger";

// -----------------------------------------------------------------------------
// RAW: cells exactly as stored in the workbook
// -----------------------------------------------------------------------------
export type RawCellValue = string | number | boolean | null;

export interface RawCell {
  /** SheetJS cell type: s(tring) n(umber) b(oolean) e(rror) d(ate) z(stub). */
  type: "s" | "n" | "b" | "e" | "d" | "z";
  value: RawCellValue;
  /** True when the cell holds a formula (its value is the cached result). */
  formula: boolean;
}

export interface RawRow {
  /** 1-based row number in the sheet. */
  row: number;
  cells: (RawCell | null)[];
}

export interface RawSheet {
  name: string;
  rows: RawRow[];
}

export interface RawWorkbook {
  sheetNames: string[];
  sheets: Record<string, RawSheet>;
  date1904: boolean;
}

// -----------------------------------------------------------------------------
// PARSED: source rows mapped to named columns (values still unnormalized)
// -----------------------------------------------------------------------------
export interface ParsedRow<F extends string> {
  sheet: string;
  row: number;
  fields: Record<F, RawCell | null>;
}

export type CategoryField = "name" | "prefix" | "description";
export type LocationField = "code" | "zone" | "shelf" | "position" | "description";
export type ProductField =
  | "code"
  | "category"
  | "brand"
  | "model"
  | "specification"
  | "unit"
  | "initialStock"
  | "minimumStock"
  | "location"
  | "supplier"
  | "legacyQr"
  | "active"
  | "registeredOn"
  | "notes"
  | "workbookCurrentStock"
  | "workbookStatus";
export type MovementField =
  | "date"
  | "type"
  | "code"
  | "category"
  | "product"
  | "quantity"
  | "project"
  | "responsible"
  | "document"
  | "notes";

export interface ParsedWorkbook {
  sheetNames: string[];
  ignoredSheets: string[];
  categories: ParsedRow<CategoryField>[];
  locations: ParsedRow<LocationField>[];
  products: ParsedRow<ProductField>[];
  movements: ParsedRow<MovementField>[];
  /** Data rows (any non-derived cell filled) per relevant sheet. */
  rawCounts: Record<string, { dataRows: number; usedRows: number }>;
}

// -----------------------------------------------------------------------------
// NORMALIZED: typed, trimmed, NFC, blanks → null
// -----------------------------------------------------------------------------
export interface SourceLocation {
  sheet: string;
  row: number;
}

export interface NormalizedCategory {
  name: string;
  prefix: string;
  description: string | null;
  source: SourceLocation;
}

export interface NormalizedLocation {
  code: string;
  zone: string | null;
  shelf: string | null;
  position: string | null;
  description: string | null;
  source: SourceLocation;
}

export interface NormalizedProduct {
  code: string;
  categoryName: string;
  brand: string | null;
  model: string | null;
  specification: string | null;
  unit: string;
  initialStock: number;
  minimumStock: number;
  locationCode: string;
  active: boolean;
  /** Legacy "Data Cadastro Sistema" as a calendar date (YYYY-MM-DD). */
  registeredOn: string;
  /** Provenance only: never written to products.qr_code. */
  legacyQr: string | null;
  notes: string | null;
  /** Cached result of the workbook's own "Estoque Atual" formula (cross-check only). */
  workbookCurrentStock: number | null;
  source: SourceLocation;
}

export type LegacyMovementType = "Entrada" | "Saída" | "Ajuste";

export interface NormalizedHistoricalMovement {
  /** Calendar date (YYYY-MM-DD) as written in the workbook. */
  date: string;
  legacyType: LegacyMovementType;
  type: MovementType;
  productCode: string;
  /** Always positive; the type carries the sign. */
  quantity: number;
  /** Quantity exactly as written (adjustments are signed in the legacy sheet). */
  legacyQuantity: number;
  /** Provenance only: never mapped to a user/profile. */
  responsible: string | null;
  project: string | null;
  document: string | null;
  notes: string | null;
  /** Cached lookup results of the workbook (cross-check only). */
  workbookCategory: string | null;
  workbookProduct: string | null;
  source: SourceLocation;
}

/** An OPENING_BALANCE derived from a product's initial stock (> 0 only). */
export interface NormalizedOpeningBalance {
  productCode: string;
  quantity: number;
  /** Product registration date (YYYY-MM-DD). */
  date: string;
  source: SourceLocation;
}

export interface NormalizedData {
  categories: NormalizedCategory[];
  locations: NormalizedLocation[];
  excludedLocations: (NormalizedLocation & { reason: string })[];
  products: NormalizedProduct[];
  openingBalances: NormalizedOpeningBalance[];
  movements: NormalizedHistoricalMovement[];
}

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------
export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  sheet?: string;
  row?: number;
  column?: string;
}

// -----------------------------------------------------------------------------
// IMPORT PLAN: what a future importer writes, fully determined
// -----------------------------------------------------------------------------
export type ImportEntityType = "category" | "location" | "product" | "stock_movement";

export interface PlannedRecord {
  entityType: ImportEntityType;
  sourceReference: string;
  sourceSheet: string;
  sourceRow: number | null;
  /** Normalized source snapshot (import_records.source_data). Never secrets. */
  sourceData: Record<string, unknown>;
}

export interface PlannedCategory {
  sourceReference: string;
  name: string;
  prefix: string;
  description: string | null;
}

export interface PlannedLocation {
  sourceReference: string;
  code: string;
  zone: string | null;
  shelf: string | null;
  position: string | null;
  description: string | null;
}

export interface PlannedProduct {
  sourceReference: string;
  code: string;
  categoryPrefix: string;
  brand: string | null;
  model: string | null;
  specification: string | null;
  unit: string;
  minimumStock: number;
  locationCode: string;
  active: boolean;
  /** products.qr_code stays NULL (decision of the stage 8 audit). */
  qrCode: null;
  /** products.created_at = start of the legacy registration day in Lisbon. */
  createdAt: string;
}

export interface PlannedMovement {
  sourceReference: string;
  productCode: string;
  type: MovementType;
  quantity: number;
  /** stock_movements.created_at = start of the legacy day in Lisbon. */
  createdAt: string;
  documentReference: string | null;
  notes: string | null;
  kind: "opening" | "historical";
}

export interface Reconciliation {
  categories: number;
  locations: number;
  suppliers: number;
  products: number;
  openingBalances: number;
  openingQuantity: number;
  historicalMovements: number;
  historicalNet: number;
  finalQuantity: number;
  byCategory: { name: string; prefix: string; initial: number; historicalNet: number; final: number }[];
}

export interface ImportPlan {
  source: { fileName: string; sha256: string; importVersion: string };
  /** Resolved to a profile id only at import time; never the legacy "Responsável". */
  executedByEmail: string;
  categories: PlannedCategory[];
  locations: PlannedLocation[];
  products: PlannedProduct[];
  movements: PlannedMovement[];
  records: PlannedRecord[];
  reconciliation: Reconciliation;
}

export type PipelineResult =
  | { ok: true; plan: ImportPlan; warnings: ValidationIssue[]; parsed: ParsedWorkbook }
  | { ok: false; errors: ValidationIssue[]; warnings: ValidationIssue[]; parsed: ParsedWorkbook | null };
