import { isStockStatus, type StockStatus } from "@/lib/stock/status";
import { listMovements, type MovementRow } from "./movements";
import { failLoad, type DbClient } from "./master-data/shared";

/**
 * Dashboard read model (read-only).
 *
 * Balances and statuses come from the view public.product_stock, which derives
 * them from the ledger; this module only counts and sums what the view returns
 * and never recomputes a status.
 */

export interface StockSummary {
  /** Active products. */
  products: number;
  /** Sum of the current balance of the active products. */
  totalStock: number;
  byStatus: Record<StockStatus, number>;
  /** Distinct units of the active products (the total only has one unit when this has one entry). */
  units: string[];
}

export interface StockRow {
  balance: number | null;
  status: string | null;
  unit: string | null;
}

/** Pure aggregation of product_stock rows (statuses are taken as given). */
export function summarizeStock(rows: readonly StockRow[]): StockSummary {
  const byStatus: Record<StockStatus, number> = { OUT_OF_STOCK: 0, REORDER: 0, OK: 0 };
  const units = new Set<string>();
  let totalStock = 0;
  for (const row of rows) {
    totalStock += row.balance ?? 0;
    if (isStockStatus(row.status)) byStatus[row.status] += 1;
    if (row.unit) units.add(row.unit);
  }
  return { products: rows.length, totalStock, byStatus, units: [...units].sort() };
}

/** PostgREST returns at most 1000 rows per request: read in pages so nothing is silently cut. */
export const STOCK_SUMMARY_PAGE_SIZE = 1000;

export async function getStockSummary(client: DbClient): Promise<StockSummary> {
  const rows: StockRow[] = [];
  for (let start = 0; ; start += STOCK_SUMMARY_PAGE_SIZE) {
    const { data, error } = await client
      .from("product_stock")
      .select("balance, status, unit")
      .eq("active", true)
      .order("id")
      .range(start, start + STOCK_SUMMARY_PAGE_SIZE - 1);
    if (error) failLoad("os indicadores de stock", error);
    rows.push(...data);
    if (data.length < STOCK_SUMMARY_PAGE_SIZE) break;
  }
  return summarizeStock(rows);
}

export const RECENT_MOVEMENTS_LIMIT = 5;

/** Most recent ledger rows, through the same query used by /movimentacoes. */
export async function listRecentMovements(client: DbClient, limit = RECENT_MOVEMENTS_LIMIT): Promise<MovementRow[]> {
  const result = await listMovements(client, {}, limit);
  return result.rows;
}
