import type { Metadata } from "next";
import Link from "next/link";
import KpiCard from "@/components/dashboard/KpiCard";
import MovementsTable from "@/components/movements/MovementsTable";
import { LinkButton } from "@/components/ui/Button";
import EmptyState from "@/components/ui/EmptyState";
import PageHeader from "@/components/ui/PageHeader";
import { requireActiveUser } from "@/lib/auth/session";
import { dashboardKpis } from "@/lib/dashboard/kpis";
import { createClient } from "@/lib/supabase/server";
import { getStockSummary, listRecentMovements, RECENT_MOVEMENTS_LIMIT } from "@/services/dashboard";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * Read-only overview. Numbers come from the view product_stock (derived from
 * the ledger) and the latest ledger rows; loading and errors use the (app)
 * route boundaries plus the dashboard skeleton in loading.tsx.
 */
export default async function DashboardPage() {
  await requireActiveUser();
  const client = await createClient();
  const [summary, recent] = await Promise.all([getStockSummary(client), listRecentMovements(client)]);
  const kpis = dashboardKpis(summary);

  return (
    <>
      <PageHeader title="Dashboard" description="Visão geral do inventário, calculada a partir do histórico de movimentações." />

      <section aria-labelledby="kpis-heading">
        <h2 id="kpis-heading" className="sr-only">
          Indicadores de stock
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((kpi) => (
            <KpiCard key={kpi.key} kpi={kpi} />
          ))}
        </div>
        {summary.products === 0 && (
          <div className="mt-4">
            <EmptyState
              title="Ainda não existem produtos ativos"
              description="Os indicadores serão preenchidos quando houver produtos ativos no catálogo."
              action={
                <Link href="/produtos" className="text-sm font-medium text-brand underline">
                  Ir para produtos
                </Link>
              }
            />
          </div>
        )}
      </section>

      <section aria-labelledby="recent-heading" className="mt-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="recent-heading" className="text-base font-semibold text-slate-900">
            Movimentações recentes
          </h2>
          <LinkButton href="/movimentacoes" variant="secondary">
            Ver todas as movimentações
          </LinkButton>
        </div>
        {recent.length === 0 ? (
          <EmptyState title="Ainda não existem movimentações" description="As movimentações aparecerão aqui quando forem registadas." />
        ) : (
          <>
            <p className="mb-2 text-sm text-slate-600">
              {recent.length === RECENT_MOVEMENTS_LIMIT ? `Últimas ${RECENT_MOVEMENTS_LIMIT}` : `${recent.length}`}{" "}
              {recent.length === 1 ? "movimentação" : "movimentações"}, mais recentes primeiro.
            </p>
            <MovementsTable rows={recent} />
          </>
        )}
      </section>
    </>
  );
}
