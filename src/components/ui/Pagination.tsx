import Link from "next/link";
import { buttonClass } from "./Button";

/** Server-side pagination links that keep the current query string. */
export default function Pagination({
  basePath,
  params,
  page,
  pageSize,
  total,
}: {
  basePath: string;
  params: Record<string, string>;
  page: number;
  pageSize: number;
  total: number;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  const href = (target: number) => {
    const query = new URLSearchParams({ ...params, pagina: String(target) });
    return `${basePath}?${query.toString()}`;
  };

  return (
    <nav aria-label="Paginação" className="mt-4 flex items-center justify-between gap-3 text-sm">
      {page > 1 ? (
        <Link href={href(page - 1)} className={buttonClass("secondary")} rel="prev">
          ← Anterior
        </Link>
      ) : (
        <span />
      )}
      <span className="text-slate-600">
        Página {Math.min(page, pages)} de {pages}
      </span>
      {page < pages ? (
        <Link href={href(page + 1)} className={buttonClass("secondary")} rel="next">
          Seguinte →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}
