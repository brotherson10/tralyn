import { STOCK_STATUS_LABELS } from "@/lib/stock/status";
import type { StockSummary } from "@/services/dashboard";

export type KpiTone = "neutral" | "amber" | "red";

export interface Kpi {
  key: "totalStock" | "products" | "reorder" | "outOfStock";
  label: string;
  value: number;
  /** Shown after the value only when every active product uses the same unit. */
  unit: string | null;
  description: string;
  tone: KpiTone;
  /** /produtos filtered to the products behind the number. */
  href: string;
}

const ACTIVE_PRODUCTS = "/produtos?estado=ativos";

/** Dashboard cards from the stock summary. Values come only from the summary (no hardcoded numbers). */
export function dashboardKpis(summary: StockSummary): Kpi[] {
  const singleUnit = summary.units.length === 1 ? summary.units[0] : null;
  return [
    {
      key: "totalStock",
      label: "Stock total",
      value: summary.totalStock,
      unit: singleUnit,
      description:
        summary.units.length > 1
          ? "Soma dos saldos dos produtos ativos (unidades diferentes)."
          : "Soma dos saldos atuais dos produtos ativos.",
      tone: "neutral",
      href: ACTIVE_PRODUCTS,
    },
    {
      key: "products",
      label: "Produtos",
      value: summary.products,
      unit: null,
      description: "Produtos ativos no catálogo.",
      tone: "neutral",
      href: ACTIVE_PRODUCTS,
    },
    {
      key: "reorder",
      label: STOCK_STATUS_LABELS.REORDER,
      value: summary.byStatus.REORDER,
      unit: null,
      description: "Saldo igual ou abaixo do stock mínimo.",
      tone: summary.byStatus.REORDER > 0 ? "amber" : "neutral",
      href: `${ACTIVE_PRODUCTS}&stock=REORDER`,
    },
    {
      key: "outOfStock",
      label: STOCK_STATUS_LABELS.OUT_OF_STOCK,
      value: summary.byStatus.OUT_OF_STOCK,
      unit: null,
      description: "Produtos ativos sem saldo disponível.",
      tone: summary.byStatus.OUT_OF_STOCK > 0 ? "red" : "neutral",
      href: `${ACTIVE_PRODUCTS}&stock=OUT_OF_STOCK`,
    },
  ];
}
