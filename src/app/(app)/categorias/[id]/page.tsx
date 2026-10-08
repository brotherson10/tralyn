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
import { CATEGORY_FIELDS } from "@/lib/master-data/fields";
import { isUuid } from "@/lib/master-data/run-action";
import { createClient } from "@/lib/supabase/server";
import { getCategory } from "@/services/master-data/categories";
import { setCategoryActiveAction, updateCategoryAction } from "../actions";

export const metadata: Metadata = { title: "Categoria" };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FLASH = {
  guardada: "Alterações guardadas.",
  ativada: "Categoria ativada.",
  desativada: "Categoria desativada. Deixa de estar disponível para novos produtos, mas o histórico mantém-se.",
};

export default async function CategoryPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const category = await getCategory(await createClient(), id);
  if (!category) notFound();
  const { sucesso } = await searchParams;
  const canManage = hasPermission(user.role, "master_data:manage");

  return (
    <>
      <RecordHeader
        backHref="/categorias"
        backLabel="Categorias"
        title={category.name}
        badge={<ActiveBadge active={category.active} feminine />}
      />
      <FlashMessage value={sucesso} messages={FLASH} />

      {canManage ? (
        <>
          <RecordSection title="Dados da categoria">
            <EntityForm
              action={updateCategoryAction.bind(null, category.id)}
              fields={CATEGORY_FIELDS}
              initialValues={category}
              submitLabel="Guardar alterações"
              cancelHref="/categorias"
            />
          </RecordSection>
          <RecordSection
            title="Ativação"
            description={
              category.active
                ? "Categorias com histórico não são apagadas. Desative-a para deixar de a usar em novos produtos."
                : "Esta categoria está inativa. Pode reativá-la a qualquer momento."
            }
          >
            {category.active ? (
              <ConfirmActionForm
                action={setCategoryActiveAction.bind(null, category.id, false)}
                label="Desativar categoria"
                confirmMessage={`Desativar a categoria "${category.name}"?`}
                confirmLabel="Sim, desativar"
                variant="danger"
              />
            ) : (
              <ConfirmActionForm
                action={setCategoryActiveAction.bind(null, category.id, true)}
                label="Reativar categoria"
                confirmMessage={`Reativar a categoria "${category.name}"?`}
                confirmLabel="Sim, reativar"
              />
            )}
          </RecordSection>
        </>
      ) : (
        <RecordSection title="Dados da categoria">
          <DetailList
            items={[
              { label: "Nome", value: category.name },
              { label: "Prefixo", value: category.prefix },
              { label: "Descrição", value: category.description },
              { label: "Estado", value: category.active ? "Ativa" : "Inativa" },
            ]}
          />
        </RecordSection>
      )}

      <RecordMeta createdAt={category.created_at} updatedAt={category.updated_at} />
    </>
  );
}
