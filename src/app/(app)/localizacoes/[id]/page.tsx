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
import { LOCATION_FIELDS } from "@/lib/master-data/fields";
import { isUuid } from "@/lib/master-data/run-action";
import { createClient } from "@/lib/supabase/server";
import { getLocation } from "@/services/master-data/locations";
import { setLocationActiveAction, updateLocationAction } from "../actions";

export const metadata: Metadata = { title: "Localização" };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FLASH = {
  guardada: "Alterações guardadas.",
  ativada: "Localização ativada.",
  desativada: "Localização desativada. Deixa de estar disponível para novos produtos, mas o histórico mantém-se.",
};

export default async function LocationPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const location = await getLocation(await createClient(), id);
  if (!location) notFound();
  const { sucesso } = await searchParams;
  const canManage = hasPermission(user.role, "master_data:manage");

  return (
    <>
      <RecordHeader
        backHref="/localizacoes"
        backLabel="Localizações"
        title={location.code}
        badge={<ActiveBadge active={location.active} feminine />}
        subtitle={location.description ?? undefined}
      />
      <FlashMessage value={sucesso} messages={FLASH} />

      {canManage ? (
        <>
          <RecordSection title="Dados da localização">
            <EntityForm
              action={updateLocationAction.bind(null, location.id)}
              fields={LOCATION_FIELDS}
              initialValues={location}
              submitLabel="Guardar alterações"
              cancelHref="/localizacoes"
            />
          </RecordSection>
          <RecordSection
            title="Ativação"
            description={
              location.active
                ? "Localizações não são apagadas. Desative-a quando deixar de existir no armazém."
                : "Esta localização está inativa. Pode reativá-la a qualquer momento."
            }
          >
            {location.active ? (
              <ConfirmActionForm
                action={setLocationActiveAction.bind(null, location.id, false)}
                label="Desativar localização"
                confirmMessage={`Desativar a localização "${location.code}"?`}
                confirmLabel="Sim, desativar"
                variant="danger"
              />
            ) : (
              <ConfirmActionForm
                action={setLocationActiveAction.bind(null, location.id, true)}
                label="Reativar localização"
                confirmMessage={`Reativar a localização "${location.code}"?`}
                confirmLabel="Sim, reativar"
              />
            )}
          </RecordSection>
        </>
      ) : (
        <RecordSection title="Dados da localização">
          <DetailList
            items={[
              { label: "Código", value: location.code },
              { label: "Zona / estante", value: location.zone },
              { label: "Prateleira", value: location.shelf },
              { label: "Posição", value: location.position },
              { label: "Descrição", value: location.description },
              { label: "Estado", value: location.active ? "Ativa" : "Inativa" },
            ]}
          />
        </RecordSection>
      )}

      <RecordMeta createdAt={location.created_at} updatedAt={location.updated_at} />
    </>
  );
}
