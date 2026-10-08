"use server";

import type { FormState } from "@/lib/forms";
import { isUuid, runFormAction, runSimpleAction } from "@/lib/master-data/run-action";
import { PRODUCT_FIELD_NAMES } from "@/lib/products/fields";
import { createProduct, setProductActive, updateProduct } from "@/services/products";
import { productSchema } from "@/validation/products";

/**
 * Product mutations. None of them touches stock: balance changes only through
 * stock movements (next stage).
 */

const INVALID: FormState = { status: "error", message: "Registo inválido." };

export async function createProductAction(_state: FormState, formData: FormData): Promise<FormState> {
  return runFormAction({
    formData,
    fields: PRODUCT_FIELD_NAMES,
    schema: productSchema,
    mutate: createProduct,
    permission: "products:manage",
    revalidate: ["/produtos"],
    successUrl: (id) => `/produtos/${id}?sucesso=criado`,
  });
}

export async function updateProductAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  if (!isUuid(id)) return INVALID;
  return runFormAction({
    formData,
    fields: PRODUCT_FIELD_NAMES,
    schema: productSchema,
    mutate: (client, input) => updateProduct(client, id, input),
    permission: "products:manage",
    revalidate: ["/produtos", `/produtos/${id}`],
    successUrl: () => `/produtos/${id}?sucesso=guardado`,
  });
}

export async function setProductActiveAction(id: string, active: boolean): Promise<FormState> {
  if (typeof active !== "boolean") return INVALID;
  return runSimpleAction({
    id,
    mutate: (client, recordId) => setProductActive(client, recordId, active),
    permission: "products:manage",
    revalidate: ["/produtos", `/produtos/${id}`],
    successUrl: `/produtos/${id}?sucesso=${active ? "ativado" : "desativado"}`,
  });
}
