import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ConfirmActionForm from "@/components/forms/ConfirmActionForm";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader, RecordMeta, RecordSection } from "@/components/master-data/RecordLayout";
import { ActiveBadge } from "@/components/ui/Badge";
import DetailList from "@/components/ui/DetailList";
import FlashMessage from "@/components/ui/FlashMessage";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { SUPPLIER_FIELDS } from "@/lib/master-data/fields";
import { isUuid } from "@/lib/master-data/run-action";
import { createClient } from "@/lib/supabase/server";
import { getSupplier } from "@/services/master-data/suppliers";
import { setSupplierActiveAction, updateSupplierAction } from "../actions";

export const metadata: Metadata = { title: "Fornecedor" };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FLASH = {
  guardado: "Alterações guardadas.",
  ativado: "Fornecedor ativado.",
  desativado: "Fornecedor desativado. Deixa de ser sugerido em novos produtos, mas o histórico mantém-se.",
};

export default async function SupplierPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const supplier = await getSupplier(await createClient(), id);
  if (!supplier) notFound();
  const { sucesso } = await searchParams;
  const canManage = hasPermission(user.role, "master_data:manage");

  return (
    <>
      <RecordHeader
        backHref="/fornecedores"
        backLabel="Fornecedores"
        title={supplier.name}
        badge={<ActiveBadge active={supplier.active} />}
      />
      <FlashMessage value={sucesso} messages={FLASH} />

      {canManage ? (
        <>
          <RecordSection title="Dados do fornecedor">
            <EntityForm
              action={updateSupplierAction.bind(null, supplier.id)}
              fields={SUPPLIER_FIELDS}
              initialValues={supplier}
              submitLabel="Guardar alterações"
              cancelHref="/fornecedores"
            />
          </RecordSection>
          <RecordSection
            title="Ativação"
            description={
              supplier.active
                ? "Fornecedores não são apagados. Desative-o quando deixar de trabalhar com o armazém."
                : "Este fornecedor está inativo. Pode reativá-lo a qualquer momento."
            }
          >
            {supplier.active ? (
              <ConfirmActionForm
                action={setSupplierActiveAction.bind(null, supplier.id, false)}
                label="Desativar fornecedor"
                confirmMessage={`Desativar o fornecedor "${supplier.name}"?`}
                confirmLabel="Sim, desativar"
                variant="danger"
              />
            ) : (
              <ConfirmActionForm
                action={setSupplierActiveAction.bind(null, supplier.id, true)}
                label="Reativar fornecedor"
                confirmMessage={`Reativar o fornecedor "${supplier.name}"?`}
                confirmLabel="Sim, reativar"
              />
            )}
          </RecordSection>
        </>
      ) : (
        <RecordSection title="Dados do fornecedor">
          <DetailList
            items={[
              { label: "Nome", value: supplier.name },
              { label: "Pessoa de contacto", value: supplier.contact_person },
              { label: "Email", value: supplier.email },
              { label: "Telefone", value: supplier.phone },
              { label: "Observações", value: supplier.notes },
              { label: "Estado", value: supplier.active ? "Ativo" : "Inativo" },
            ]}
          />
        </RecordSection>
      )}

      <RecordMeta createdAt={supplier.created_at} updatedAt={supplier.updated_at} />
    </>
  );
}
