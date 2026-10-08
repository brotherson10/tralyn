import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RecordHeader, RecordSection } from "@/components/master-data/RecordLayout";
import { movementEffectLabel, MovementTypeBadge, SignedQuantity } from "@/components/movements/MovementDisplay";
import { LinkButton } from "@/components/ui/Button";
import DetailList from "@/components/ui/DetailList";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { isUuid } from "@/lib/master-data/run-action";
import { productLabel } from "@/lib/products/display";
import { MOVEMENT_TYPE_LABELS } from "@/lib/stock/ledger";
import { createClient } from "@/lib/supabase/server";
import { getMovement } from "@/services/movements";

export const metadata: Metadata = { title: "Movimentação" };

type Params = Promise<{ id: string }>;

const exactDateTime = new Intl.DateTimeFormat("pt-PT", {
  dateStyle: "long",
  timeStyle: "medium",
  timeZone: "Europe/Lisbon",
});

/**
 * Read-only record of one ledger line (audit view). There is intentionally no
 * edit or delete: corrections are new adjustment movements.
 */
export default async function MovementPage({ params }: { params: Params }) {
  const user = await requireActiveUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const movement = await getMovement(await createClient(), id);
  if (!movement) notFound();
  const canAdjust = hasPermission(user.role, "movements:adjust") && movement.product.active;

  return (
    <>
      <RecordHeader
        backHref="/movimentacoes"
        backLabel="Movimentações"
        title={`${MOVEMENT_TYPE_LABELS[movement.type]} · ${movement.product.code}`}
        badge={<MovementTypeBadge type={movement.type} />}
        subtitle={exactDateTime.format(new Date(movement.created_at))}
      />

      <RecordSection title="Registo">
        <DetailList
          items={[
            { label: "Tipo", value: `${MOVEMENT_TYPE_LABELS[movement.type]} (${movementEffectLabel(movement.type)})` },
            {
              label: "Quantidade",
              value: <SignedQuantity type={movement.type} quantity={movement.quantity} unit={movement.product.unit} />,
            },
            {
              label: "Produto",
              value: (
                <Link href={`/produtos/${movement.product.id}`} className="text-brand hover:underline">
                  {movement.product.code} — {productLabel(movement.product)}
                </Link>
              ),
            },
            {
              label: "Projeto",
              value: movement.project ? (
                <Link href={`/projetos/${movement.project.id}`} className="text-brand hover:underline">
                  {movement.project.name}
                  {movement.project.reference ? ` (${movement.project.reference})` : ""}
                </Link>
              ) : null,
            },
            { label: "Responsável", value: movement.user?.name },
            { label: "Data/hora (registada pela base de dados)", value: exactDateTime.format(new Date(movement.created_at)) },
            { label: "Referência / documento", value: movement.document_reference },
            { label: "Observações", value: movement.notes },
            { label: "Identificador", value: <code className="text-xs">{movement.id}</code> },
          ]}
        />
      </RecordSection>

      <div role="note" className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        Movimentações são imutáveis: não podem ser editadas nem apagadas. Se este registo estiver errado, registe uma
        movimentação de ajuste que o compense, explicando o motivo nas observações.
        {canAdjust && (
          <div className="mt-3">
            <LinkButton href={`/movimentacoes/nova?produto=${movement.product.id}`} variant="secondary">
              Registar ajuste para {movement.product.code}
            </LinkButton>
          </div>
        )}
      </div>
    </>
  );
}
