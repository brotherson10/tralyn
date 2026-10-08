/**
 * Tralyn "ledger T": two ledger lines (the movement history) form the bar of
 * a "T" that rests on a solid stem (the current, derived stock state).
 *
 * Drawn on a 16-unit grid so every edge lands on a whole pixel at 16 and 32 px
 * (the favicon in src/app/icon.svg uses the same geometry). Monochrome via
 * currentColor: set the color with a text-* class on the symbol.
 */
export function TralynSymbol({
  size = 24,
  className = "",
  title,
}: {
  size?: number;
  className?: string;
  /** Accessible name; omit when the symbol is decorative (e.g. next to the wordmark). */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="currentColor"
      className={`shrink-0 ${className}`.trim()}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <rect x="1" y="1" width="14" height="2" rx="1" />
      <rect x="1" y="4" width="14" height="2" rx="1" />
      <rect x="6" y="7" width="4" height="8" rx="1" />
    </svg>
  );
}

/**
 * Symbol + "Tralyn" wordmark (or the symbol alone with `variant="symbol"`).
 * The wordmark text is the accessible name, so the symbol stays decorative.
 */
export default function TralynLogo({
  variant = "full",
  size = 24,
  className = "",
  symbolClassName = "text-brand",
  wordmarkClassName = "",
}: {
  variant?: "full" | "symbol";
  size?: number;
  className?: string;
  /** Color of the symbol, e.g. "text-brand" on light or "text-brand-on-dark" on dark backgrounds. */
  symbolClassName?: string;
  /** Typography/color of the wordmark; it inherits the surrounding text color by default. */
  wordmarkClassName?: string;
}) {
  if (variant === "symbol") {
    return <TralynSymbol size={size} className={`${symbolClassName} ${className}`} title="Tralyn" />;
  }
  return (
    <span className={`inline-flex items-center gap-2 ${className}`.trim()}>
      <TralynSymbol size={size} className={symbolClassName} />
      <span className={`font-bold tracking-tight ${wordmarkClassName}`.trim()}>Tralyn</span>
    </span>
  );
}
