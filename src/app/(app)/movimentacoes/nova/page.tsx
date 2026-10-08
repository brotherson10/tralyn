import type { Metadata } from "next";
import Link from "next/link";
import { RecordHeader } from "@/components/master-data/RecordLayout";
import MovementForm from "@/components/movements/MovementForm";
import { SignedQuantity } from "@/components/movements/MovementDisplay";
import { StockStatusBadge } from "@/components/ui/Badge";
import { operationalMovementTypesFor } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { isUuid } from "@/lib/master-data/run-action";
import { MOVEMENT_TYPE_LABELS } from "@/lib/stock/ledger";
import { createClient } from "@/lib/supabase/server";
import { buttonClass } from "@/components/ui/Button";
import { getMovement, loadMovementFormOptions, MOVEMENT_PRODUCT_OPTIONS_LIMIT } from "@/services/movements";
import { sanitizeSearch } from "@/validation/master-data";
import { getProductStock } from "@/services/products";
import { registerMovementAction } from "../actions";

export const metadata: Metadata = { title: "Nova movimentação" };

/** "Entrada/Saída … registada", "Ajuste … registado". */
const REGISTERED_WORD = { IN: "registada", OUT: "registada", ADJUSTMENT_IN: "registado", ADJUSTMENT_OUT: "registado", OPENING_BALANCE: "registado" } as const;

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function NewMovementPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requirePermission("movements:in_out");
  const params = await searchParams;
  const client = await createClient();

  // Feedback after a successful registration: everything is re-read from the database.
  const registered = isUuid(params.registada) ? await getMovement(client, params.registada) : null;
  const stockAfter = registered ? await getProductStock(client, registered.product.id) : null;

  const initialProductId = isUuid(params.produto) ? params.produto : null;
  const search = sanitizeSearch(params.busca);
  const options = await loadMovementFormOptions(client, { search, includeProductId: initialProductId });

  return (
    <>
      <RecordHeader
        backHref="/movimentacoes"
        backLabel="Movimentações"
        title="Nova movimentação"
        subtitle="Registe entradas e saídas de material. O stock é atualizado a partir deste registo."
      />

      {registered && stockAfter && (
        <div role="status" className="mb-6 max-w-3xl rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <p className="font-semibold">
            {MOVEMENT_TYPE_LABELS[registered.type]} de {registered.quantity} {registered.product.unit} {REGISTERED_WORD[registered.type]} para{" "}
            {registered.product.code}.
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2">
            <span>Efeito:</span>
            <SignedQuantity type={registered.type} quantity={registered.quantity} unit={registered.product.unit} />
            <span>· Saldo atual:</span>
            <strong data-testid="balance-after">
              {stockAfter.balance} {stockAfter.unit}
            </strong>
            <StockStatusBadge status={stockAfter.status} />
          </p>
          <p className="mt-2 flex gap-4">
            <Link href={`/movimentacoes/${registered.id}`} className="font-medium underline">
              Ver movimentação
            </Link>
            <Link href={`/produtos/${registered.product.id}`} className="font-medium underline">
              Ver produto
            </Link>
          </p>
        </div>
      )}

      <form method="get" action="/movimentacoes/nova" role="search" className="mb-4 flex max-w-3xl flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="busca" className="block text-sm font-medium text-slate-700">
            Encontrar produto
          </label>
          <input
            id="busca"
            name="busca"
            type="search"
            defaultValue={search}
            maxLength={80}
            placeholder="Código, marca ou modelo"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30"
          />
        </div>
        <button type="submit" className={buttonClass("secondary")}>
          Procurar
        </button>
      </form>
      <p className="mb-4 text-xs text-slate-500" aria-live="polite">
        {options.matchingProducts > MOVEMENT_PRODUCT_OPTIONS_LIMIT
          ? `A mostrar ${MOVEMENT_PRODUCT_OPTIONS_LIMIT} de ${options.matchingProducts} produtos ativos${search ? " encontrados" : ""}. Pesquise pelo código para encontrar outros.`
          : `${options.matchingProducts} ${options.matchingProducts === 1 ? "produto ativo" : "produtos ativos"}${search ? ` para “${search}”` : ""}.`}
      </p>

      {options.products.length === 0 ? (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          {search
            ? "Nenhum produto ativo corresponde à pesquisa."
            : "Não existe nenhum produto ativo. Crie ou reative um produto antes de registar movimentações."}
        </div>
      ) : (
        <MovementForm
          action={registerMovementAction}
          products={options.products}
          projects={options.projects}
          allowedTypes={operationalMovementTypesFor(user.role)}
          initialProductId={initialProductId}
        />
      )}
    </>
  );
}
