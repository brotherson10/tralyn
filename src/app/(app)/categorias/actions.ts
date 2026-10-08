"use server";

import type { FormState } from "@/lib/forms";
import { CATEGORY_FIELDS } from "@/lib/master-data/fields";
import { isUuid, runFormAction, runSimpleAction } from "@/lib/master-data/run-action";
import { createCategory, setCategoryActive, updateCategory } from "@/services/master-data/categories";
import { categorySchema } from "@/validation/master-data";

const INVALID: FormState = { status: "error", message: "Registo inválido." };

export async function createCategoryAction(_state: FormState, formData: FormData): Promise<FormState> {
  return runFormAction({
    formData,
    fields: CATEGORY_FIELDS,
    schema: categorySchema,
    mutate: createCategory,
    revalidate: ["/categorias"],
    successUrl: () => "/categorias?sucesso=criada",
  });
}

export async function updateCategoryAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  if (!isUuid(id)) return INVALID;
  return runFormAction({
    formData,
    fields: CATEGORY_FIELDS,
    schema: categorySchema,
    mutate: (client, input) => updateCategory(client, id, input),
    revalidate: ["/categorias", `/categorias/${id}`],
    successUrl: () => `/categorias/${id}?sucesso=guardada`,
  });
}

export async function setCategoryActiveAction(id: string, active: boolean): Promise<FormState> {
  if (typeof active !== "boolean") return INVALID;
  return runSimpleAction({
    id,
    mutate: (client, recordId) => setCategoryActive(client, recordId, active),
    revalidate: ["/categorias", `/categorias/${id}`],
    successUrl: `/categorias/${id}?sucesso=${active ? "ativada" : "desativada"}`,
  });
}
