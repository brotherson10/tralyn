import type { Metadata } from "next";
import Link from "next/link";
import { ActiveBadge, StockStatusBadge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import SearchBar from "@/components/ui/SearchBar";
import { ResultCount, TableShell, Td, Th } from "@/components/ui/Table";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { ACTIVE_FILTER_OPTIONS } from "@/lib/master-data/filters";
import { productLabel } from "@/lib/products/display";
import { STOCK_STATUS_LABELS, STOCK_STATUSES } from "@/lib/stock/status";
import { createClient } from "@/lib/supabase/server";
import { listCategories } from "@/services/master-data/categories";
import { listLocations } from "@/services/master-data/locations";
import { listProducts } from "@/services/products";
import { sanitizeSearch } from "@/validation/master-data";
import { parseProductFilters } from "@/validation/products";

export const metadata: Metadata = { title: "Produtos" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const STOCK_FILTER_OPTIONS = [
  { value: "todos", label: "Todos" },
  ...STOCK_STATUSES.map((value) => ({ value, label: STOCK_STATUS_LABELS[value] })),
];

export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const filters = parseProductFilters(await searchParams, sanitizeSearch);
  const client = await createClient();
  const [products, categories, locations] = await Promise.all([
    listProducts(client, filters),
    listCategories(client),
    listLocations(client),
  ]);
  const canManage = hasPermission(user.role, "products:manage");
  const filtering =
    filters.q !== "" || filters.categoryId || filters.location || filters.active !== "todos" || filters.stock !== "todos";

  const statusCounts = STOCK_STATUSES.map((status) => ({
    status,
    count: products.filter((product) => product.status === status).length,
  }));

  return (
    <>
      <PageHeader
        title="Produtos"
        description="Catálogo do armazém. O stock é calculado a partir das movimentações registadas."
        actions={canManage ? <LinkButton href="/produtos/novo">Novo produto</LinkButton> : undefined}
      />

      <SearchBar
        basePath="/produtos"
        query={filters.q}
        placeholder="Código, marca, modelo ou especificação"
        filters={[
          {
            name: "categoria",
            label: "Categoria",
            value: filters.categoryId ?? "",
            options: [
              { value: "", label: "Todas" },
              ...categories.map((c) => ({ value: c.id, label: `${c.name}${c.active ? "" : " (inativa)"}` })),
            ],
          },
          {
            name: "localizacao",
            label: "Localização",
            value: filters.location ?? "",
            options: [
              { value: "", label: "Todas" },
              { value: "sem", label: "Sem localização" },
              ...locations.map((l) => ({ value: l.id, label: `${l.code}${l.active ? "" : " (inativa)"}` })),
            ],
          },
          { name: "stock", label: "Stock", value: filters.stock, options: STOCK_FILTER_OPTIONS },
          { name: "estado", label: "Estado", value: filters.active, options: ACTIVE_FILTER_OPTIONS.masculine },
        ]}
      />

      {products.length === 0 ? (
        <EmptyState
          title={filtering ? "Nenhum produto encontrado" : "Ainda não existem produtos"}
          description={
            filtering
              ? "Altere a pesquisa ou os filtros."
              : canManage
                ? "Crie o primeiro produto ou importe o inventário legado."
                : "Os produtos aparecerão aqui quando forem criados por um administrador."
          }
        />
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <ResultCount count={products.length} noun={["produto", "produtos"]} />
            <p className="mb-2 text-sm text-slate-600">
              {statusCounts.map(({ status, count }, index) => (
                <span key={status}>
                  {index > 0 && " · "}
                  {STOCK_STATUS_LABELS[status]}: <strong className="font-semibold text-slate-900">{count}</strong>
                </span>
              ))}
            </p>
          </div>
          <TableShell caption="Lista de produtos com stock atual">
            <thead>
              <tr>
                <Th>Código</Th>
                <Th>Produto</Th>
                <Th className="hidden md:table-cell">Categoria</Th>
                <Th className="hidden xl:table-cell">Localização</Th>
                <Th className="text-right">Stock</Th>
                <Th>Status</Th>
                <Th className="hidden sm:table-cell">Estado</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {products.map((product) => (
                <tr key={product.id} className={product.active ? "hover:bg-slate-50" : "bg-slate-50/60 text-slate-500"}>
                  <Td className="whitespace-nowrap">
                    <Link href={`/produtos/${product.id}`} className="font-mono font-semibold text-brand hover:underline">
                      {product.code}
                    </Link>
                  </Td>
                  <Td>
                    <span className="font-medium text-slate-900">{productLabel(product)}</span>
                    {!product.model && <span className="block text-xs italic text-slate-500">Modelo não indicado</span>}
                    {product.specification && <span className="block text-xs text-slate-500">{product.specification}</span>}
                    {!product.active && <span className="mt-1 inline-block sm:hidden"><ActiveBadge active={false} /></span>}
                  </Td>
                  <Td className="hidden md:table-cell">{product.category_name}</Td>
                  <Td className="hidden xl:table-cell">{product.location_code ?? "—"}</Td>
                  <Td className="whitespace-nowrap text-right tabular-nums">
                    <span className="font-semibold text-slate-900">{product.balance}</span>{" "}
                    <span className="text-xs text-slate-500">{product.unit}</span>
                    <span className="block text-xs text-slate-500">mín. {product.minimum_stock}</span>
                  </Td>
                  <Td>
                    <StockStatusBadge status={product.status} />
                  </Td>
                  <Td className="hidden sm:table-cell">
                    <ActiveBadge active={Boolean(product.active)} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableShell>
        </>
      )}
    </>
  );
}
