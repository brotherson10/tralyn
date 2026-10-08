import type { Metadata } from "next";
import Link from "next/link";
import { ActiveBadge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import FlashMessage from "@/components/ui/FlashMessage";
import PageHeader from "@/components/ui/PageHeader";
import SearchBar from "@/components/ui/SearchBar";
import { ResultCount, TableShell, Td, Th } from "@/components/ui/Table";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { ACTIVE_FILTER_OPTIONS } from "@/lib/master-data/filters";
import { createClient } from "@/lib/supabase/server";
import { listCategories } from "@/services/master-data/categories";
import { parseActiveFilter, sanitizeSearch } from "@/validation/master-data";

export const metadata: Metadata = { title: "Categorias" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CategoriesPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const params = await searchParams;
  const q = sanitizeSearch(params.q);
  const estado = parseActiveFilter(params.estado);
  const categories = await listCategories(await createClient(), { q, active: estado });
  const canManage = hasPermission(user.role, "master_data:manage");
  const filtering = q !== "" || estado !== "todos";

  return (
    <>
      <PageHeader
        title="Categorias"
        description="Famílias de produtos. O prefixo identifica a categoria nos códigos dos produtos."
        actions={canManage ? <LinkButton href="/categorias/nova">Nova categoria</LinkButton> : undefined}
      />
      <FlashMessage value={params.sucesso} messages={{ criada: "Categoria criada com sucesso." }} />
      <SearchBar
        basePath="/categorias"
        query={q}
        placeholder="Nome, prefixo ou descrição"
        filters={[{ name: "estado", label: "Estado", value: estado, options: ACTIVE_FILTER_OPTIONS.feminine }]}
      />

      {categories.length === 0 ? (
        <EmptyState
          title={filtering ? "Nenhuma categoria encontrada" : "Ainda não existem categorias"}
          description={
            filtering
              ? "Altere a pesquisa ou o filtro de estado."
              : canManage
                ? "Crie a primeira categoria ou importe o inventário legado."
                : "As categorias aparecerão aqui quando forem criadas por um administrador."
          }
        />
      ) : (
        <>
          <ResultCount count={categories.length} noun={["categoria", "categorias"]} />
          <TableShell caption="Lista de categorias">
            <thead>
              <tr>
                <Th>Nome</Th>
                <Th>Prefixo</Th>
                <Th className="hidden md:table-cell">Descrição</Th>
                <Th>Estado</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {categories.map((category) => (
                <tr key={category.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`/categorias/${category.id}`} className="font-medium text-brand hover:underline">
                      {category.name}
                    </Link>
                  </Td>
                  <Td>
                    <code className="rounded bg-slate-100 px-1.5 py-0.5 text-xs font-semibold">{category.prefix}</code>
                  </Td>
                  <Td className="hidden max-w-md text-slate-600 md:table-cell">{category.description ?? "—"}</Td>
                  <Td>
                    <ActiveBadge active={category.active} feminine />
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
