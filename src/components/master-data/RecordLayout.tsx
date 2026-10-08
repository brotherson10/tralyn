import Link from "next/link";
import { formatDateTime } from "@/lib/format";

/** Header for create/detail pages: back link, title, optional badge. */
export function RecordHeader({
  backHref,
  backLabel,
  title,
  badge,
  subtitle,
}: {
  backHref: string;
  backLabel: string;
  title: string;
  badge?: React.ReactNode;
  subtitle?: string;
}) {
  return (
    <div className="mb-6">
      <Link href={backHref} className="text-sm font-medium text-brand hover:text-brand-hover hover:underline">
        ← {backLabel}
      </Link>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 break-words">{title}</h1>
        {badge}
      </div>
      {subtitle && <p className="mt-1 text-sm text-slate-600">{subtitle}</p>}
    </div>
  );
}

/** Titled block on a record page (e.g. "Dados", "Estado"). */
export function RecordSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const headingId = `section-${slugify(title)}`;
  return (
    <section className="mb-8" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-base font-semibold text-slate-900">
        {title}
      </h2>
      {description && <p className="mt-1 text-sm text-slate-600">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function RecordMeta({ createdAt, updatedAt }: { createdAt: string; updatedAt: string }) {
  return (
    <p className="text-xs text-slate-500">
      Criado em {formatDateTime(createdAt)} · Última alteração em {formatDateTime(updatedAt)}
    </p>
  );
}
