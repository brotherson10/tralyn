import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ConfirmActionForm from "@/components/forms/ConfirmActionForm";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader, RecordMeta, RecordSection } from "@/components/master-data/RecordLayout";
import { ProjectStatusBadge } from "@/components/ui/Badge";
import DetailList from "@/components/ui/DetailList";
import FlashMessage from "@/components/ui/FlashMessage";
import { hasPermission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { PROJECT_FIELDS } from "@/lib/master-data/fields";
import { isUuid } from "@/lib/master-data/run-action";
import { createClient } from "@/lib/supabase/server";
import { getProject } from "@/services/master-data/projects";
import { PROJECT_STATUS_LABELS, type ProjectStatus } from "@/validation/master-data";
import { setProjectStatusAction, updateProjectAction } from "../actions";

export const metadata: Metadata = { title: "Projeto" };

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FLASH = {
  guardado: "Alterações guardadas.",
  "estado-active": "Projeto reaberto (Ativo).",
  "estado-completed": "Projeto marcado como Concluído.",
  "estado-cancelled": "Projeto Cancelado. O histórico de movimentações mantém-se.",
};

/** Quick status transitions offered on the record page. */
const TRANSITIONS: Record<ProjectStatus, { to: ProjectStatus; label: string; confirm: string; danger?: boolean }[]> = {
  active: [
    { to: "completed", label: "Marcar como concluído", confirm: "Marcar este projeto como Concluído?" },
    { to: "cancelled", label: "Cancelar projeto", confirm: "Cancelar este projeto?", danger: true },
  ],
  completed: [{ to: "active", label: "Reabrir projeto", confirm: "Reabrir este projeto (voltar a Ativo)?" }],
  cancelled: [{ to: "active", label: "Reabrir projeto", confirm: "Reabrir este projeto (voltar a Ativo)?" }],
};

export default async function ProjectPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const user = await requireActiveUser();
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const project = await getProject(await createClient(), id);
  if (!project) notFound();
  const { sucesso } = await searchParams;
  const canManage = hasPermission(user.role, "master_data:manage");

  return (
    <>
      <RecordHeader
        backHref="/projetos"
        backLabel="Projetos"
        title={project.name}
        badge={<ProjectStatusBadge status={project.status} />}
        subtitle={[project.client, project.reference].filter(Boolean).join(" · ") || undefined}
      />
      <FlashMessage value={sucesso} messages={FLASH} />

      {canManage ? (
        <>
          <RecordSection
            title="Estado do projeto"
            description="Só projetos ativos podem ser associados a novas movimentações. Projetos não são apagados."
          >
            <div className="flex flex-wrap gap-4">
              {TRANSITIONS[project.status].map((transition) => (
                <ConfirmActionForm
                  key={transition.to}
                  action={setProjectStatusAction.bind(null, project.id, transition.to)}
                  label={transition.label}
                  confirmMessage={transition.confirm}
                  confirmLabel={`Sim, ${PROJECT_STATUS_LABELS[transition.to].toLowerCase()}`}
                  variant={transition.danger ? "danger" : "secondary"}
                />
              ))}
            </div>
          </RecordSection>
          <RecordSection title="Dados do projeto">
            <EntityForm
              action={updateProjectAction.bind(null, project.id)}
              fields={PROJECT_FIELDS}
              initialValues={project}
              submitLabel="Guardar alterações"
              cancelHref="/projetos"
            />
          </RecordSection>
        </>
      ) : (
        <RecordSection title="Dados do projeto">
          <DetailList
            items={[
              { label: "Nome", value: project.name },
              { label: "Cliente", value: project.client },
              { label: "Referência", value: project.reference },
              { label: "Estado", value: PROJECT_STATUS_LABELS[project.status] },
              { label: "Observações", value: project.notes },
            ]}
          />
        </RecordSection>
      )}

      <RecordMeta createdAt={project.created_at} updatedAt={project.updated_at} />
    </>
  );
}
