export const STOCK_STATUSES = ["OUT_OF_STOCK", "REORDER", "OK"] as const;

export type StockStatus = (typeof STOCK_STATUSES)[number];

/** UI labels. The status itself always comes from the database (view product_stock). */
export const STOCK_STATUS_LABELS: Record<StockStatus, string> = {
  OUT_OF_STOCK: "Sem stock",
  REORDER: "Repor stock",
  OK: "OK",
};

export function isStockStatus(value: unknown): value is StockStatus {
  return typeof value === "string" && (STOCK_STATUSES as readonly string[]).includes(value);
}

/**
 * SEM ESTOQUE: saldo <= 0
 * REPOR:       saldo > 0 e saldo <= minimum_stock
 * OK:          saldo > minimum_stock
 */
export function stockStatus(balance: number, minimumStock: number): StockStatus {
  if (balance <= 0) return "OUT_OF_STOCK";
  if (balance <= minimumStock) return "REORDER";
  return "OK";
}
