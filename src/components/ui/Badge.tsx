import { isStockStatus, STOCK_STATUS_LABELS, type StockStatus } from "@/lib/stock/status";
import { PROJECT_STATUS_LABELS, type ProjectStatus } from "@/validation/master-data";

export type BadgeTone = "green" | "gray" | "blue" | "red" | "amber";

const TONES: Record<BadgeTone, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-600/20",
  gray: "bg-slate-100 text-slate-700 ring-slate-500/20",
  blue: "bg-sky-50 text-sky-800 ring-sky-600/20",
  red: "bg-red-50 text-red-800 ring-red-600/20",
  amber: "bg-amber-50 text-amber-900 ring-amber-600/30",
};

export function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {children}
    </span>
  );
}

/** Ativa/Inativa (feminine nouns: categoria, localização) or Ativo/Inativo. */
export function ActiveBadge({ active, feminine = false }: { active: boolean; feminine?: boolean }) {
  const label = active ? (feminine ? "Ativa" : "Ativo") : feminine ? "Inativa" : "Inativo";
  return <Badge tone={active ? "green" : "gray"}>{label}</Badge>;
}

const PROJECT_TONES: Record<ProjectStatus, BadgeTone> = { active: "green", completed: "blue", cancelled: "gray" };

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_TONES[status]}>{PROJECT_STATUS_LABELS[status]}</Badge>;
}

const STOCK_TONES: Record<StockStatus, BadgeTone> = { OUT_OF_STOCK: "red", REORDER: "amber", OK: "green" };

/** Status as computed by the database (view product_stock); this only maps it to a label/colour. */
export function StockStatusBadge({ status }: { status: string | null }) {
  if (!isStockStatus(status)) return <Badge tone="gray">—</Badge>;
  return <Badge tone={STOCK_TONES[status]}>{STOCK_STATUS_LABELS[status]}</Badge>;
}
