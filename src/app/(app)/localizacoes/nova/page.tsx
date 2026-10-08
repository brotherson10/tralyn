import type { Metadata } from "next";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader } from "@/components/master-data/RecordLayout";
import { requirePermission } from "@/lib/auth/session";
import { LOCATION_FIELDS } from "@/lib/master-data/fields";
import { createLocationAction } from "../actions";

export const metadata: Metadata = { title: "Nova localização" };

export default async function NewLocationPage() {
  await requirePermission("master_data:manage");
  return (
    <>
      <RecordHeader backHref="/localizacoes" backLabel="Localizações" title="Nova localização" />
      <EntityForm
        action={createLocationAction}
        fields={LOCATION_FIELDS}
        submitLabel="Criar localização"
        cancelHref="/localizacoes"
      />
    </>
  );
}
