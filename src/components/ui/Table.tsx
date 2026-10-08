/** Horizontally scrollable table container with consistent styling. */
export function TableShell({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <th scope="col" className={`bg-slate-50 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-slate-600 ${className}`}>
      {children}
    </th>
  );
}

export function Td({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top text-slate-800 ${className}`}>{children}</td>;
}

export function ResultCount({ count, noun }: { count: number; noun: [string, string] }) {
  return (
    <p className="mb-2 text-sm text-slate-600" aria-live="polite">
      {count} {count === 1 ? noun[0] : noun[1]}
    </p>
  );
}
