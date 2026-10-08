/**
 * Tralyn public demo workbook: 100% fictional data in the legacy layout
 * (same sheets, exact headers, cell types, Excel date serials, "Sim"/"Não",
 * signed "Ajuste" quantities, a template example location and derived
 * formula columns with cached values), so the canonical pipeline runs on a
 * versioned, public-safe file.
 *
 * The committed file (CANONICAL_WORKBOOK_PATH) is generated from this module
 * and is byte-for-byte reproducible:
 *
 *   npm run inventory:demo-workbook
 *
 * Changing anything here changes the SHA-256 in CANONICAL_EXPECTATIONS.
 */
import * as XLSX from "xlsx";
import { CATEGORY_COLUMNS, LOCATION_COLUMNS, MOVEMENT_COLUMNS, PRODUCT_COLUMNS, SHEETS } from "./expectations";

type Cell = string | number | null;

/** Excel 1900-system serial of a calendar day (no time). */
export function excelSerial(isoDay: string): number {
  const [y, m, d] = isoDay.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Every product is registered on this (fictional) day. */
export const DEMO_REGISTERED_ON = "2026-03-02";

export const DEMO_CATEGORIES: [name: string, prefix: string, description: string | null][] = [
  ["Solar Panels", "PAN", "Photovoltaic modules"],
  ["Inverters", "INV", "Hybrid and string inverters"],
  ["Batteries", "BAT", "Energy storage"],
  ["EV Chargers", "EVC", null],
  ["Mounting & Protection", "MNT", "Mounting structures and electrical protection"],
];

export const DEMO_LOCATIONS: [code: string, zone: string | null, shelf: string | null, position: string | null, description: string | null][] = [
  ["WH-A-01", "Main Warehouse", "A", "01", "Main Warehouse A-01"],
  ["RACK-B-02", "Rack B", "B", "02", "Rack B-02"],
  ["YARD-01", "Overflow Yard", null, null, "Overflow Yard"],
];

/** Template row of the legacy sheet; excluded by the expectations, never imported. */
export const DEMO_EXAMPLE_LOCATION: [string, string, string, string, string] = ["Z-99-99", "Z", "99", "99", "Exemplo"];

interface DemoProduct {
  code: string;
  category: string;
  brand: string | null;
  model: string | null;
  specification: string | null;
  unit: string;
  initialStock: number;
  minimumStock: number;
  location: string;
  legacyQr: string | null;
  notes: string | null;
}

/**
 * Edge cases: brand-only (EVC-401) and model-only (MNT-501, MNT-502, MNT-504)
 * products; surrounding whitespace (PAN-102 brand); a decomposed (NFD)
 * accent (MNT-502 specification); a blank optional field; a legacy QR id that
 * differs from the code (MNT-504) and product notes (EVC-402), both preserved
 * only as provenance.
 */
export const DEMO_PRODUCTS: DemoProduct[] = [
  { code: "PAN-101", category: "Solar Panels", brand: "Sunvolt", model: "SV-450", specification: "450 W mono", unit: "un", initialStock: 36, minimumStock: 10, location: "WH-A-01", legacyQr: "PAN-101", notes: null },
  { code: "PAN-102", category: "Solar Panels", brand: "  Sunvolt ", model: "SV-550", specification: "550 W bifacial", unit: "un", initialStock: 18, minimumStock: 8, location: "WH-A-01", legacyQr: "PAN-102", notes: null },
  { code: "INV-201", category: "Inverters", brand: "Voltaris", model: "VT-H5", specification: "Hybrid inverter 5 kW", unit: "un", initialStock: 0, minimumStock: 2, location: "RACK-B-02", legacyQr: "INV-201", notes: null },
  { code: "INV-202", category: "Inverters", brand: "Voltaris", model: "VT-S10", specification: "String inverter 10 kW", unit: "un", initialStock: 3, minimumStock: 3, location: "RACK-B-02", legacyQr: "INV-202", notes: null },
  { code: "BAT-301", category: "Batteries", brand: "Gridora", model: "GD-B5", specification: "Battery module 5 kWh", unit: "un", initialStock: 14, minimumStock: 4, location: "RACK-B-02", legacyQr: "BAT-301", notes: null },
  { code: "BAT-302", category: "Batteries", brand: "Gridora", model: "GD-RK4", specification: "Battery rack kit", unit: "kit", initialStock: 2, minimumStock: 1, location: "RACK-B-02", legacyQr: "BAT-302", notes: null },
  { code: "EVC-401", category: "EV Chargers", brand: "Northgrid", model: null, specification: "EV charger 7 kW", unit: "un", initialStock: 7, minimumStock: 2, location: "WH-A-01", legacyQr: "EVC-401", notes: null },
  { code: "EVC-402", category: "EV Chargers", brand: "Northgrid", model: "NG-22", specification: "EV charger 22 kW", unit: "un", initialStock: 0, minimumStock: 1, location: "WH-A-01", legacyQr: "EVC-402", notes: "Demo: awaiting first delivery" },
  { code: "MNT-501", category: "Mounting & Protection", brand: null, model: "Mounting Rail 4 m", specification: "Aluminium", unit: "un", initialStock: 64, minimumStock: 20, location: "YARD-01", legacyQr: "MNT-501", notes: null },
  { code: "MNT-502", category: "Mounting & Protection", brand: null, model: "Roof Hook", specification: "Aço inoxidável", unit: "un", initialStock: 120, minimumStock: 40, location: "YARD-01", legacyQr: "MNT-502", notes: null },
  { code: "MNT-503", category: "Mounting & Protection", brand: "Gridora", model: "GD-DC1000", specification: "DC isolator 1000 V", unit: "un", initialStock: 4, minimumStock: 6, location: "WH-A-01", legacyQr: null, notes: null },
  { code: "MNT-504", category: "Mounting & Protection", brand: null, model: "Connector Pair", specification: null, unit: "par", initialStock: 75, minimumStock: 25, location: "WH-A-01", legacyQr: "LEG-MNT-504", notes: null },
];

export const DEMO_RESPONSIBLE = "Demo Operator";

interface DemoMovement {
  date: string;
  type: "Entrada" | "Saída" | "Ajuste";
  code: string;
  /** Positive for Entrada/Saída; signed for Ajuste (legacy convention). */
  quantity: number;
  document: string | null;
  notes: string | null;
}

export const DEMO_MOVEMENTS: DemoMovement[] = [
  { date: "2026-03-16", type: "Entrada", code: "PAN-101", quantity: 6, document: "DEMO-GR-0001", notes: null },
  { date: "2026-04-15", type: "Entrada", code: "INV-201", quantity: 5, document: null, notes: "Demo stock receipt" },
  { date: "2026-04-22", type: "Saída", code: "PAN-102", quantity: 12, document: "DEMO-OUT-0001", notes: null },
  { date: "2026-05-06", type: "Ajuste", code: "BAT-302", quantity: -2, document: null, notes: "Demo cycle count: 2 units damaged" },
  { date: "2026-05-06", type: "Ajuste", code: "MNT-502", quantity: 5, document: null, notes: "Demo cycle count: 5 extra units found" },
];

const signed = (m: DemoMovement) => (m.type === "Saída" ? -m.quantity : m.quantity);

/** Current stock per product, as the workbook's own formulas compute it. */
export function demoCurrentStock(code: string): number {
  const product = DEMO_PRODUCTS.find((p) => p.code === code)!;
  return DEMO_MOVEMENTS.filter((m) => m.code === code).reduce((sum, m) => sum + signed(m), product.initialStock);
}

function workbookStatus(current: number, minimum: number): string {
  if (current <= 0) return "SEM STOCK";
  return current <= minimum ? "REPOR" : "OK";
}

const MOVEMENTS_SHEET = `'${SHEETS.movements}'`;

/** Builds the demo workbook (deterministic bytes). */
export function buildDemoWorkbook(): Uint8Array {
  const wb = XLSX.utils.book_new();
  const add = (name: string, rows: Cell[][]) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, sheet, name);
    return sheet;
  };
  const day = excelSerial(DEMO_REGISTERED_ON);

  add(SHEETS.categories, [CATEGORY_COLUMNS.map((c) => c.header), ...DEMO_CATEGORIES]);
  add(SHEETS.locations, [LOCATION_COLUMNS.map((c) => c.header), ...DEMO_LOCATIONS, DEMO_EXAMPLE_LOCATION]);
  add("FORNECEDORES", [["Fornecedor", "Contacto", "Email", "Telefone", "Observações"]]);
  add("UTILIZADORES", [["Nome", "Perfil", "Ativo?", "Email"], [DEMO_RESPONSIBLE, "Operador", "Sim", null]]);

  const products = add(SHEETS.products, [
    PRODUCT_COLUMNS.map((c) => c.header),
    ...DEMO_PRODUCTS.map((p) => {
      const current = demoCurrentStock(p.code);
      return [
        p.code, p.category, p.brand, p.model, p.specification, p.unit, p.initialStock, p.minimumStock, p.location, null,
        p.legacyQr, "Sim", day, p.notes, current, workbookStatus(current, p.minimumStock),
      ];
    }),
  ]);
  // Derived columns are formulas in the legacy workbook (cached values kept).
  DEMO_PRODUCTS.forEach((_p, i) => {
    const r = i + 2;
    const sum = (type: string) => `SUMIFS(${MOVEMENTS_SHEET}!F:F,${MOVEMENTS_SHEET}!C:C,A${r},${MOVEMENTS_SHEET}!B:B,"${type}")`;
    products[`O${r}`].f = `G${r}+${sum("Entrada")}-${sum("Saída")}+${sum("Ajuste")}`;
    products[`P${r}`].f = `IF(O${r}<=0,"SEM STOCK",IF(O${r}<=H${r},"REPOR","OK"))`;
  });

  const movements = add(SHEETS.movements, [
    MOVEMENT_COLUMNS.map((c) => c.header),
    ...DEMO_MOVEMENTS.map((m) => {
      const product = DEMO_PRODUCTS.find((p) => p.code === m.code)!;
      return [excelSerial(m.date), m.type, m.code, product.category, product.model, m.quantity, null, DEMO_RESPONSIBLE, m.document, m.notes];
    }),
  ]);
  DEMO_MOVEMENTS.forEach((_m, i) => {
    const r = i + 2;
    movements[`D${r}`].f = `VLOOKUP(C${r},PRODUTOS!A:B,2,FALSE)`;
    movements[`E${r}`].f = `VLOOKUP(C${r},PRODUTOS!A:D,4,FALSE)`;
  });

  add("DASHBOARD", [["Indicador", "Valor"], ["Produtos", DEMO_PRODUCTS.length]]);

  wb.Props = { Title: "Tralyn demo inventory", Author: "Tralyn", CreatedDate: new Date(Date.UTC(2026, 2, 2)) };
  return new Uint8Array(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer);
}
