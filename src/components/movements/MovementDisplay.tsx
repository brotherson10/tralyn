import { isAdjustment, MOVEMENT_TYPE_LABELS, signedQuantity, type MovementType } from "@/lib/stock/ledger";

/**
 * Movement type badge. Types differ by symbol, text and border style, not
 * only by colour: adjustments use a dashed border so they stand apart from
 * regular entries/outputs.
 */
const STYLES: Record<MovementType, { symbol: string; className: string }> = {
  IN: { symbol: "+", className: "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/30" },
  OUT: { symbol: "−", className: "bg-sky-50 text-sky-900 ring-1 ring-sky-600/30" },
  ADJUSTMENT_IN: { symbol: "+", className: "border border-dashed border-amber-500 bg-amber-50 text-amber-900" },
  ADJUSTMENT_OUT: { symbol: "−", className: "border border-dashed border-amber-500 bg-amber-50 text-amber-900" },
  OPENING_BALANCE: { symbol: "=", className: "bg-slate-100 text-slate-700 ring-1 ring-slate-400/40" },
};

export function MovementTypeBadge({ type }: { type: MovementType }) {
  const style = STYLES[type];
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded px-2 py-0.5 text-xs font-semibold ${style.className}`}
      data-movement-type={type}
    >
      <span aria-hidden="true" className="font-mono">
        {style.symbol}
      </span>
      {MOVEMENT_TYPE_LABELS[type]}
    </span>
  );
}

/** Quantity with the sign implied by the type (quantities are stored positive). */
export function SignedQuantity({ type, quantity, unit }: { type: MovementType; quantity: number; unit?: string }) {
  const signed = signedQuantity(type, quantity);
  const text = `${signed > 0 ? "+" : "−"}${Math.abs(signed)}`;
  return (
    <span className={`whitespace-nowrap font-semibold tabular-nums ${signed > 0 ? "text-emerald-800" : "text-slate-900"}`}>
      {text}
      {unit ? <span className="ml-1 text-xs font-normal text-slate-500">{unit}</span> : null}
    </span>
  );
}

export const MOVEMENT_TYPE_DESCRIPTIONS: Record<MovementType, string> = {
  IN: "Material recebido no armazém. Aumenta o stock.",
  OUT: "Material entregue ou consumido. Diminui o stock.",
  ADJUSTMENT_IN: "Correção após contagem ou conferência. Aumenta o stock.",
  ADJUSTMENT_OUT: "Correção por perda, dano ou contagem. Diminui o stock.",
  OPENING_BALANCE: "Saldo inicial registado na importação do inventário.",
};

export function movementEffectLabel(type: MovementType): string {
  return signedQuantity(type, 1) > 0 ? "aumenta o stock" : "diminui o stock";
}

export { isAdjustment };
