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
import { listSuppliers } from "@/services/master-data/suppliers";
import { parseActiveFilter, sanitizeSearch } from "@/validation/master-data";

export const metadata: Metadata = { title: "Fornecedores" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function SuppliersPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const params = await searchParams;
  const q = sanitizeSearch(params.q);
  const estado = parseActiveFilter(params.estado);
  const suppliers = await listSuppliers(await createClient(), { q, active: estado });
  const canManage = hasPermission(user.role, "master_data:manage");
  const filtering = q !== "" || estado !== "todos";

  return (
    <>
      <PageHeader
        title="Fornecedores"
        description="Empresas que fornecem os produtos do armazém."
        actions={canManage ? <LinkButton href="/fornecedores/novo">Novo fornecedor</LinkButton> : undefined}
      />
      <FlashMessage value={params.sucesso} messages={{ criado: "Fornecedor criado com sucesso." }} />
      <SearchBar
        basePath="/fornecedores"
        query={q}
        placeholder="Nome, contacto, email ou telefone"
        filters={[{ name: "estado", label: "Estado", value: estado, options: ACTIVE_FILTER_OPTIONS.masculine }]}
      />

      {suppliers.length === 0 ? (
        <EmptyState
          title={filtering ? "Nenhum fornecedor encontrado" : "Ainda não existem fornecedores"}
          description={
            filtering
              ? "Altere a pesquisa ou o filtro de estado."
              : canManage
                ? "Registe os fornecedores com quem o armazém trabalha."
                : "Os fornecedores aparecerão aqui quando forem criados por um administrador."
          }
        />
      ) : (
        <>
          <ResultCount count={suppliers.length} noun={["fornecedor", "fornecedores"]} />
          <TableShell caption="Lista de fornecedores">
            <thead>
              <tr>
                <Th>Nome</Th>
                <Th className="hidden md:table-cell">Contacto</Th>
                <Th className="hidden lg:table-cell">Email</Th>
                <Th className="hidden lg:table-cell">Telefone</Th>
                <Th>Estado</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {suppliers.map((supplier) => (
                <tr key={supplier.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`/fornecedores/${supplier.id}`} className="font-medium text-brand hover:underline">
                      {supplier.name}
                    </Link>
                  </Td>
                  <Td className="hidden md:table-cell">{supplier.contact_person ?? "—"}</Td>
                  <Td className="hidden break-all lg:table-cell">{supplier.email ?? "—"}</Td>
                  <Td className="hidden whitespace-nowrap lg:table-cell">{supplier.phone ?? "—"}</Td>
                  <Td>
                    <ActiveBadge active={supplier.active} />
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
