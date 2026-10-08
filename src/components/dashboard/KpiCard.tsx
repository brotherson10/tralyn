import Link from "next/link";
import { statCardClass, statLabelClass, statValueClass } from "@/components/ui/StatCard";
import type { Kpi, KpiTone } from "@/lib/dashboard/kpis";

const TONES: Record<KpiTone, { card: string; value: string }> = {
  neutral: { card: "border-slate-200", value: "text-slate-900" },
  amber: { card: "border-amber-300 bg-amber-50/40", value: "text-amber-900" },
  red: { card: "border-red-300 bg-red-50/40", value: "text-red-800" },
};

/** One dashboard indicator; the whole card links to the products behind the number. */
export default function KpiCard({ kpi }: { kpi: Kpi }) {
  const tone = TONES[kpi.tone];
  return (
    <Link
      href={kpi.href}
      className={`block ${statCardClass} transition-colors hover:border-brand/40 focus-visible:outline-2 focus-visible:outline-brand ${tone.card}`}
      data-kpi={kpi.key}
    >
      <p className={statLabelClass}>{kpi.label}</p>
      <p className={`${statValueClass} ${tone.value}`}>
        {kpi.value.toLocaleString("pt-PT")}
        {kpi.unit ? <span className="ml-1 text-base font-normal text-slate-500">{kpi.unit}</span> : null}
      </p>
      <p className="mt-1 text-xs text-slate-500">{kpi.description}</p>
    </Link>
  );
}
