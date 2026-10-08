import Link from "next/link";
import { buttonClass } from "./Button";

export type SearchFilter =
  | {
      kind?: "select";
      name: string;
      label: string;
      value: string;
      /** The first option is the default ("all"). */
      options: readonly { value: string; label: string }[];
    }
  | { kind: "date"; name: string; label: string; value: string };

interface SearchBarProps {
  basePath: string;
  query: string;
  placeholder: string;
  filters: readonly SearchFilter[];
  /** Extra query parameters to keep (e.g. a product scope). */
  hidden?: Record<string, string>;
}

/** A secondary filter is active when it differs from its default ("all" / empty date). */
export function isFilterActive(filter: SearchFilter): boolean {
  return filter.kind === "date" ? filter.value !== "" : filter.value !== filter.options[0]?.value;
}

/**
 * GET form: filters live in the URL (shareable, back-button friendly, works without JS).
 *
 * The main search is always visible. Secondary filters sit in a native
 * <details> ("Filtros") that is collapsed on small screens and opens by itself
 * when a filter is active. From lg up they are always shown (see
 * `.search-filters` in globals.css).
 */
export default function SearchBar({ basePath, query, placeholder, filters, hidden = {} }: SearchBarProps) {
  const activeFilters = filters.filter(isFilterActive).length;
  const filtered = query !== "" || activeFilters > 0;
  const controlClass =
    "mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30";

  return (
    <form method="get" action={basePath} role="search" className="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <div className="min-w-0 flex-1 lg:min-w-64">
        <label htmlFor="q" className="block text-sm font-medium text-slate-700">
          Pesquisar
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={query}
          placeholder={placeholder}
          maxLength={80}
          className={controlClass}
        />
      </div>
      {filters.length > 0 && (
        <details className="search-filters group rounded-md border border-slate-200 bg-white lg:border-0 lg:bg-transparent" open={activeFilters > 0}>
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-3 text-sm font-medium text-slate-700 [&::-webkit-details-marker]:hidden">
            <span>
              Filtros
              {activeFilters > 0 && (
                <span className="ml-1 text-brand">
                  ({activeFilters} {activeFilters === 1 ? "ativo" : "ativos"})
                </span>
              )}
            </span>
            <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 text-slate-500 transition-transform group-open:rotate-180" fill="currentColor">
              <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06Z" />
            </svg>
          </summary>
          <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2 lg:flex lg:flex-wrap lg:gap-3 lg:p-0">
            {filters.map((filter) => (
              <div key={filter.name} className="lg:w-40">
                <label htmlFor={`filtro-${filter.name}`} className="block text-sm font-medium text-slate-700">
                  {filter.label}
                </label>
                {filter.kind === "date" ? (
                  <input
                    id={`filtro-${filter.name}`}
                    name={filter.name}
                    type="date"
                    defaultValue={filter.value}
                    className={controlClass}
                  />
                ) : (
                  <select id={`filtro-${filter.name}`} name={filter.name} defaultValue={filter.value} className={controlClass}>
                    {filter.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      <div className="flex gap-2">
        <button type="submit" className={buttonClass("secondary")}>
          Pesquisar
        </button>
        {filtered && (
          <Link href={basePath} className={buttonClass("ghost")}>
            Limpar
          </Link>
        )}
      </div>
    </form>
  );
}
