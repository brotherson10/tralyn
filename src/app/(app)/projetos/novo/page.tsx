import type { Metadata } from "next";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader } from "@/components/master-data/RecordLayout";
import { requirePermission } from "@/lib/auth/session";
import { PROJECT_FIELDS } from "@/lib/master-data/fields";
import { createProjectAction } from "../actions";

export const metadata: Metadata = { title: "Novo projeto" };

export default async function NewProjectPage() {
  await requirePermission("master_data:manage");
  return (
    <>
      <RecordHeader backHref="/projetos" backLabel="Projetos" title="Novo projeto" />
      <EntityForm
        action={createProjectAction}
        fields={PROJECT_FIELDS}
        initialValues={{ status: "active" }}
        submitLabel="Criar projeto"
        cancelHref="/projetos"
      />
    </>
  );
}
