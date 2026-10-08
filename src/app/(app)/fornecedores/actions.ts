"use server";

import type { FormState } from "@/lib/forms";
import { SUPPLIER_FIELDS } from "@/lib/master-data/fields";
import { isUuid, runFormAction, runSimpleAction } from "@/lib/master-data/run-action";
import { createSupplier, setSupplierActive, updateSupplier } from "@/services/master-data/suppliers";
import { supplierSchema } from "@/validation/master-data";

const INVALID: FormState = { status: "error", message: "Registo inválido." };

export async function createSupplierAction(_state: FormState, formData: FormData): Promise<FormState> {
  return runFormAction({
    formData,
    fields: SUPPLIER_FIELDS,
    schema: supplierSchema,
    mutate: createSupplier,
    revalidate: ["/fornecedores"],
    successUrl: () => "/fornecedores?sucesso=criado",
  });
}

export async function updateSupplierAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  if (!isUuid(id)) return INVALID;
  return runFormAction({
    formData,
    fields: SUPPLIER_FIELDS,
    schema: supplierSchema,
    mutate: (client, input) => updateSupplier(client, id, input),
    revalidate: ["/fornecedores", `/fornecedores/${id}`],
    successUrl: () => `/fornecedores/${id}?sucesso=guardado`,
  });
}

export async function setSupplierActiveAction(id: string, active: boolean): Promise<FormState> {
  if (typeof active !== "boolean") return INVALID;
  return runSimpleAction({
    id,
    mutate: (client, recordId) => setSupplierActive(client, recordId, active),
    revalidate: ["/fornecedores", `/fornecedores/${id}`],
    successUrl: `/fornecedores/${id}?sucesso=${active ? "ativado" : "desativado"}`,
  });
}
