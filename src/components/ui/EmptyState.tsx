interface EmptyStateProps {
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** Smaller padding, for an empty section inside a page (not a whole page/list). */
  compact?: boolean;
}

export default function EmptyState({ title, description, action, compact = false }: EmptyStateProps) {
  return (
    <div className={`rounded-lg border border-dashed border-slate-300 bg-white px-6 text-center ${compact ? "py-6" : "py-12"}`}>
      <p className="font-medium text-slate-900">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-600">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
