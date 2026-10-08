import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ConfirmActionForm from "@/components/forms/ConfirmActionForm";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader, RecordMeta, RecordSection } from "@/components/master-data/RecordLayout";
import { ActiveBadge, StockStatusBadge } from "@/components/ui/Badge";
import DetailList from "@/components/ui/DetailList";
import EmptyState from "@/components/ui/EmptyState";
import FlashMessage from "@/components/ui/FlashMessage";
import { StatCard, statValueClass } from "@/components/ui/StatCard";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { isUuid } from "@/lib/master-data/run-action";
import { productLabel } from "@/lib/products/display";
import { productFields } from "@/lib/products/fields";
import { createClient } from "@/lib/supabase/server";
import MovementsTable from "@/components/movements/MovementsTable";
import { LinkButton } from "@/components/ui/Button";
import { listMovements } from "@/services/movements";
import { getProduct, getProductStock, loadProductFormOptions } from "@/services/products";
import { setProductActiveAction, updateProductAction } from "../actions";

export const metadata: Metadata = { title: "Produto" };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FLASH = {
  criado: "Produto criado. O stock começa em 0 e só muda através de movimentações.",
  guardado: "Alterações guardadas. O stock não foi alterado.",
  ativado: "Produto reativado. Volta a poder receber movimentações.",
  desativado: "Produto desativado. Deixa de poder receber movimentações; o histórico mantém-se.",
};

export default async function ProductPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const client = await createClient();
  const [stock, product] = await Promise.all([getProductStock(client, id), getProduct(client, id)]);
  if (!stock || !product) notFound();

  const [options, recent] = await Promise.all([
    loadProductFormOptions(client, product),
    listMovements(client, { productId: product.id }, 10),
  ]);
  const canMove = hasPermission(user.role, "movements:in_out") && product.active;
  const relationLabel = (list: { value: string; label: string }[], value: string | null) =>
    value ? (list.find((option) => option.value === value)?.label ?? "—") : null;
  const { sucesso } = await searchParams;
  const canManage = hasPermission(user.role, "products:manage");

  return (
    <>
      <RecordHeader
        backHref="/produtos"
        backLabel="Produtos"
        title={productLabel(product)}
        badge={<ActiveBadge active={product.active} />}
        subtitle={`Código ${product.code}${product.specification ? ` · ${product.specification}` : ""}`}
      />
      <FlashMessage value={sucesso} messages={FLASH} />

      {!product.active && (
        <div role="note" className="mb-6 rounded-md border border-slate-300 bg-slate-100 px-4 py-3 text-sm text-slate-800">
          <strong>Produto inativo.</strong> Não pode receber novas movimentações de stock. O histórico existente mantém-se.
        </div>
      )}

      <RecordSection
        title="Stock"
        description="Calculado a partir do histórico de movimentações. Não é editável: só muda através de entradas, saídas ou ajustes registados."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-testid="stock-summary">
          <StatCard label="Stock atual">
            <p className={`${statValueClass} text-slate-900`} data-testid="stock-balance">
              {stock.balance} <span className="text-base font-normal text-slate-500">{stock.unit}</span>
            </p>
          </StatCard>
          <StatCard label="Stock mínimo">
            <p className={`${statValueClass} text-slate-900`}>{stock.minimum_stock}</p>
          </StatCard>
          <StatCard label="Status">
            <p className="mt-2 text-base" data-testid="stock-status">
              <StockStatusBadge status={stock.status} />
            </p>
          </StatCard>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          Última movimentação: {stock.last_movement_at ? formatDateTime(stock.last_movement_at) : "nenhuma registada"}
        </p>
      </RecordSection>

      <RecordSection
        title="Movimentações recentes"
        description={product.active ? undefined : "Produto inativo: não é possível registar novas movimentações."}
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {canMove && (
            <LinkButton href={`/movimentacoes/nova?produto=${product.id}`}>Registar movimentação</LinkButton>
          )}
          <LinkButton href={`/movimentacoes?produto=${product.id}`} variant="secondary">
            Ver histórico completo
          </LinkButton>
        </div>
        {recent.rows.length === 0 ? (
          <EmptyState compact title="Sem movimentações registadas" />
        ) : (
          <MovementsTable rows={recent.rows} showProduct={false} />
        )}
      </RecordSection>

      {canManage ? (
        <>
          <RecordSection title="Dados do produto">
            {!product.model && (
              <p role="note" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Dado incompleto: o modelo deste produto não está indicado. Preencha-o quando for conhecido.
              </p>
            )}
            <EntityForm
              action={updateProductAction.bind(null, product.id)}
              fields={productFields(options, product)}
              initialValues={product}
              submitLabel="Guardar alterações"
              cancelHref="/produtos"
            />
          </RecordSection>
          <RecordSection
            title="Ativação"
            description={
              product.active
                ? "Produtos não são apagados. Desative-o para impedir novas movimentações, mantendo o histórico."
                : "Este produto está inativo. Reative-o para voltar a registar movimentações."
            }
          >
            {product.active ? (
              <ConfirmActionForm
                action={setProductActiveAction.bind(null, product.id, false)}
                label="Desativar produto"
                confirmMessage={`Desativar o produto ${product.code}? Deixará de poder receber movimentações.`}
                confirmLabel="Sim, desativar"
                variant="danger"
              />
            ) : (
              <ConfirmActionForm
                action={setProductActiveAction.bind(null, product.id, true)}
                label="Reativar produto"
                confirmMessage={`Reativar o produto ${product.code}?`}
                confirmLabel="Sim, reativar"
              />
            )}
          </RecordSection>
        </>
      ) : (
        <RecordSection title="Dados do produto">
          <DetailList
            items={[
              { label: "Código", value: product.code },
              { label: "Categoria", value: relationLabel(options.categories, product.category_id) },
              { label: "Marca", value: product.brand },
              { label: "Modelo / produto", value: product.model ?? "Não indicado" },
              { label: "Especificação", value: product.specification },
              { label: "Unidade", value: product.unit },
              { label: "Localização", value: relationLabel(options.locations, product.location_id) },
              { label: "Fornecedor padrão", value: relationLabel(options.suppliers, product.default_supplier_id) },
              { label: "Estado", value: product.active ? "Ativo" : "Inativo" },
            ]}
          />
        </RecordSection>
      )}

      <RecordMeta createdAt={product.created_at} updatedAt={product.updated_at} />
    </>
  );
}
