import type { Metadata } from "next";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader } from "@/components/master-data/RecordLayout";
import { requirePermission } from "@/lib/auth/session";
import { CATEGORY_FIELDS } from "@/lib/master-data/fields";
import { createCategoryAction } from "../actions";

export const metadata: Metadata = { title: "Nova categoria" };

export default async function NewCategoryPage() {
  await requirePermission("master_data:manage");
  return (
    <>
      <RecordHeader backHref="/categorias" backLabel="Categorias" title="Nova categoria" />
      <EntityForm action={createCategoryAction} fields={CATEGORY_FIELDS} submitLabel="Criar categoria" cancelHref="/categorias" />
    </>
  );
}
