"use server";

import type { FormState } from "@/lib/forms";
import { PROJECT_FIELDS } from "@/lib/master-data/fields";
import { isUuid, runFormAction, runSimpleAction } from "@/lib/master-data/run-action";
import { createProject, setProjectStatus, updateProject } from "@/services/master-data/projects";
import { PROJECT_STATUSES, projectSchema, type ProjectStatus } from "@/validation/master-data";

const INVALID: FormState = { status: "error", message: "Registo inválido." };

export async function createProjectAction(_state: FormState, formData: FormData): Promise<FormState> {
  return runFormAction({
    formData,
    fields: PROJECT_FIELDS,
    schema: projectSchema,
    mutate: createProject,
    revalidate: ["/projetos"],
    successUrl: () => "/projetos?sucesso=criado",
  });
}

export async function updateProjectAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  if (!isUuid(id)) return INVALID;
  return runFormAction({
    formData,
    fields: PROJECT_FIELDS,
    schema: projectSchema,
    mutate: (client, input) => updateProject(client, id, input),
    revalidate: ["/projetos", `/projetos/${id}`],
    successUrl: () => `/projetos/${id}?sucesso=guardado`,
  });
}

export async function setProjectStatusAction(id: string, status: ProjectStatus): Promise<FormState> {
  if (!(PROJECT_STATUSES as readonly unknown[]).includes(status)) return INVALID;
  return runSimpleAction({
    id,
    mutate: (client, recordId) => setProjectStatus(client, recordId, status),
    revalidate: ["/projetos", `/projetos/${id}`],
    successUrl: `/projetos/${id}?sucesso=estado-${status}`,
  });
}
