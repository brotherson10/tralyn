import type { Metadata } from "next";
import Link from "next/link";
import { ProjectStatusBadge } from "@/components/ui/Badge";
import { LinkButton } from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import FlashMessage from "@/components/ui/FlashMessage";
import PageHeader from "@/components/ui/PageHeader";
import SearchBar from "@/components/ui/SearchBar";
import { ResultCount, TableShell, Td, Th } from "@/components/ui/Table";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { PROJECT_STATUS_FILTER_OPTIONS } from "@/lib/master-data/filters";
import { createClient } from "@/lib/supabase/server";
import { listProjects } from "@/services/master-data/projects";
import { parseProjectStatusFilter, sanitizeSearch } from "@/validation/master-data";

export const metadata: Metadata = { title: "Projetos" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function ProjectsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const params = await searchParams;
  const q = sanitizeSearch(params.q);
  const estado = parseProjectStatusFilter(params.estado);
  const projects = await listProjects(await createClient(), { q, status: estado });
  const canManage = hasPermission(user.role, "master_data:manage");
  const filtering = q !== "" || estado !== "todos";

  return (
    <>
      <PageHeader
        title="Projetos"
        description="Obras e clientes aos quais as saídas de material podem ser associadas."
        actions={canManage ? <LinkButton href="/projetos/novo">Novo projeto</LinkButton> : undefined}
      />
      <FlashMessage value={params.sucesso} messages={{ criado: "Projeto criado com sucesso." }} />
      <SearchBar
        basePath="/projetos"
        query={q}
        placeholder="Nome, cliente ou referência"
        filters={[{ name: "estado", label: "Estado", value: estado, options: PROJECT_STATUS_FILTER_OPTIONS }]}
      />

      {projects.length === 0 ? (
        <EmptyState
          title={filtering ? "Nenhum projeto encontrado" : "Ainda não existem projetos"}
          description={
            filtering
              ? "Altere a pesquisa ou o filtro de estado."
              : canManage
                ? "Registe os projetos para poder associá-los às saídas de material."
                : "Os projetos aparecerão aqui quando forem criados por um administrador."
          }
        />
      ) : (
        <>
          <ResultCount count={projects.length} noun={["projeto", "projetos"]} />
          <TableShell caption="Lista de projetos">
            <thead>
              <tr>
                <Th>Nome</Th>
                <Th className="hidden md:table-cell">Cliente</Th>
                <Th className="hidden sm:table-cell">Referência</Th>
                <Th>Estado</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {projects.map((project) => (
                <tr key={project.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`/projetos/${project.id}`} className="font-medium text-brand hover:underline">
                      {project.name}
                    </Link>
                  </Td>
                  <Td className="hidden md:table-cell">{project.client ?? "—"}</Td>
                  <Td className="hidden sm:table-cell">{project.reference ?? "—"}</Td>
                  <Td>
                    <ProjectStatusBadge status={project.status} />
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
