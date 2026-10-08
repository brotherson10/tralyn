import type { Metadata } from "next";
import Link from "next/link";
import MovementsTable from "@/components/movements/MovementsTable";
import { LinkButton } from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import Pagination from "@/components/ui/Pagination";
import SearchBar from "@/components/ui/SearchBar";
import { ResultCount } from "@/components/ui/Table";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { MOVEMENT_TYPE_LABELS, MOVEMENT_TYPES } from "@/lib/stock/ledger";
import { createClient } from "@/lib/supabase/server";
import { listProjects } from "@/services/master-data/projects";
import { listMovements } from "@/services/movements";
import { getProductStock } from "@/services/products";
import { sanitizeSearch } from "@/validation/master-data";
import { parseMovementFilters } from "@/validation/movements";

export const metadata: Metadata = { title: "Movimentações" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TYPE_OPTIONS = [
  { value: "", label: "Todos" },
  ...MOVEMENT_TYPES.map((value) => ({ value, label: MOVEMENT_TYPE_LABELS[value] })),
];

export default async function MovementsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const filters = parseMovementFilters(await searchParams, sanitizeSearch);
  const client = await createClient();
  const [result, projects, scopedProduct] = await Promise.all([
    listMovements(client, filters),
    listProjects(client),
    filters.productId ? getProductStock(client, filters.productId) : Promise.resolve(null),
  ]);
  const canRegister = hasPermission(user.role, "movements:in_out");
  const filtering = Boolean(
    filters.q || filters.type || filters.productId || filters.projectId || filters.from || filters.to,
  );

  // Current filters, to keep them in pagination links.
  const query: Record<string, string> = {};
  if (filters.q) query.q = filters.q;
  if (filters.type) query.tipo = filters.type;
  if (filters.productId) query.produto = filters.productId;
  if (filters.projectId) query.projeto = filters.projectId;
  if (filters.from) query.de = filters.from;
  if (filters.to) query.ate = filters.to;

  return (
    <>
      <PageHeader
        title="Movimentações"
        description="Histórico imutável de entradas, saídas e ajustes. O stock de cada produto é a soma destas linhas."
        actions={
          canRegister ? (
            <LinkButton href={filters.productId ? `/movimentacoes/nova?produto=${filters.productId}` : "/movimentacoes/nova"}>
              Nova movimentação
            </LinkButton>
          ) : undefined
        }
      />

      {scopedProduct && (
        <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-slate-700">
          A mostrar apenas o produto
          <Link href={`/produtos/${scopedProduct.id}`} className="font-mono font-semibold text-brand hover:underline">
            {scopedProduct.code}
          </Link>
          ·
          <Link href="/movimentacoes" className="text-brand underline hover:text-brand-hover">
            ver todos os produtos
          </Link>
        </p>
      )}

      <SearchBar
        basePath="/movimentacoes"
        query={filters.q}
        placeholder="Código, marca ou modelo do produto"
        hidden={filters.productId ? { produto: filters.productId } : undefined}
        filters={[
          { name: "tipo", label: "Tipo", value: filters.type ?? "", options: TYPE_OPTIONS },
          {
            name: "projeto",
            label: "Projeto",
            value: filters.projectId ?? "",
            options: [{ value: "", label: "Todos" }, ...projects.map((p) => ({ value: p.id, label: p.name }))],
          },
          { kind: "date", name: "de", label: "De", value: filters.from ?? "" },
          { kind: "date", name: "ate", label: "Até", value: filters.to ?? "" },
        ]}
      />

      {result.rows.length === 0 ? (
        <EmptyState
          title={
            result.outOfRange
              ? "Esta página não existe"
              : filtering
                ? "Nenhuma movimentação encontrada"
                : "Ainda não existem movimentações"
          }
          description={
            result.outOfRange
              ? "Volte à primeira página dos resultados."
              : filtering
                ? "Altere a pesquisa ou os filtros."
                : canRegister
                  ? "Registe a primeira entrada de material para começar o histórico."
                  : "As movimentações aparecerão aqui quando forem registadas."
          }
          action={
            result.outOfRange ? (
              <Link href="/movimentacoes" className="text-sm font-medium text-brand underline">
                Primeira página
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <ResultCount count={result.total} noun={["movimentação", "movimentações"]} />
          <MovementsTable rows={result.rows} />
          <Pagination
            basePath="/movimentacoes"
            params={query}
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
          />
        </>
      )}
    </>
  );
}
