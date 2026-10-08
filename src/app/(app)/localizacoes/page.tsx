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
import { listLocations } from "@/services/master-data/locations";
import { parseActiveFilter, sanitizeSearch } from "@/validation/master-data";

export const metadata: Metadata = { title: "Localizações" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LocationsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const params = await searchParams;
  const q = sanitizeSearch(params.q);
  const estado = parseActiveFilter(params.estado);
  const locations = await listLocations(await createClient(), { q, active: estado });
  const canManage = hasPermission(user.role, "master_data:manage");
  const filtering = q !== "" || estado !== "todos";

  return (
    <>
      <PageHeader
        title="Localizações"
        description="Posições físicas do armazém onde os produtos são guardados."
        actions={canManage ? <LinkButton href="/localizacoes/nova">Nova localização</LinkButton> : undefined}
      />
      <FlashMessage value={params.sucesso} messages={{ criada: "Localização criada com sucesso." }} />
      <SearchBar
        basePath="/localizacoes"
        query={q}
        placeholder="Código, zona, prateleira ou descrição"
        filters={[{ name: "estado", label: "Estado", value: estado, options: ACTIVE_FILTER_OPTIONS.feminine }]}
      />

      {locations.length === 0 ? (
        <EmptyState
          title={filtering ? "Nenhuma localização encontrada" : "Ainda não existem localizações"}
          description={
            filtering
              ? "Altere a pesquisa ou o filtro de estado."
              : canManage
                ? "Registe as posições do armazém (ex.: zona A, prateleira 01, posição 01)."
                : "As localizações aparecerão aqui quando forem criadas por um administrador."
          }
        />
      ) : (
        <>
          <ResultCount count={locations.length} noun={["localização", "localizações"]} />
          <TableShell caption="Lista de localizações">
            <thead>
              <tr>
                <Th>Código</Th>
                <Th className="hidden sm:table-cell">Zona</Th>
                <Th className="hidden sm:table-cell">Prateleira</Th>
                <Th className="hidden sm:table-cell">Posição</Th>
                <Th className="hidden lg:table-cell">Descrição</Th>
                <Th>Estado</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {locations.map((location) => (
                <tr key={location.id} className="hover:bg-slate-50">
                  <Td>
                    <Link href={`/localizacoes/${location.id}`} className="font-medium text-brand hover:underline">
                      {location.code}
                    </Link>
                  </Td>
                  <Td className="hidden sm:table-cell">{location.zone ?? "—"}</Td>
                  <Td className="hidden sm:table-cell">{location.shelf ?? "—"}</Td>
                  <Td className="hidden sm:table-cell">{location.position ?? "—"}</Td>
                  <Td className="hidden max-w-md text-slate-600 lg:table-cell">{location.description ?? "—"}</Td>
                  <Td>
                    <ActiveBadge active={location.active} feminine />
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
