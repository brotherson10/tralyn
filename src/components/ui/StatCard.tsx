/**
 * Shared look of "stat" cards (a label over a big number): dashboard KPIs and
 * the stock cards of the product page. Only semantically equivalent cards use it.
 */
export const statCardClass = "rounded-lg border bg-white p-4 shadow-sm";
export const statLabelClass = "text-sm font-medium text-slate-600";
export const statValueClass = "mt-1 text-3xl font-semibold tabular-nums";

export function StatCard({
  label,
  children,
  className = "border-slate-200",
}: {
  label: string;
  children: React.ReactNode;
  /** Border/background tone (defaults to the neutral slate border). */
  className?: string;
}) {
  return (
    <div className={`${statCardClass} ${className}`}>
      <p className={statLabelClass}>{label}</p>
      {children}
    </div>
  );
}
