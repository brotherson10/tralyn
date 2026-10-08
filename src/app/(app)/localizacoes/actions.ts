"use server";

import type { FormState } from "@/lib/forms";
import { LOCATION_FIELDS } from "@/lib/master-data/fields";
import { isUuid, runFormAction, runSimpleAction } from "@/lib/master-data/run-action";
import { createLocation, setLocationActive, updateLocation } from "@/services/master-data/locations";
import { locationSchema } from "@/validation/master-data";

const INVALID: FormState = { status: "error", message: "Registo inválido." };

export async function createLocationAction(_state: FormState, formData: FormData): Promise<FormState> {
  return runFormAction({
    formData,
    fields: LOCATION_FIELDS,
    schema: locationSchema,
    mutate: createLocation,
    revalidate: ["/localizacoes"],
    successUrl: () => "/localizacoes?sucesso=criada",
  });
}

export async function updateLocationAction(id: string, _state: FormState, formData: FormData): Promise<FormState> {
  if (!isUuid(id)) return INVALID;
  return runFormAction({
    formData,
    fields: LOCATION_FIELDS,
    schema: locationSchema,
    mutate: (client, input) => updateLocation(client, id, input),
    revalidate: ["/localizacoes", `/localizacoes/${id}`],
    successUrl: () => `/localizacoes/${id}?sucesso=guardada`,
  });
}

export async function setLocationActiveAction(id: string, active: boolean): Promise<FormState> {
  if (typeof active !== "boolean") return INVALID;
  return runSimpleAction({
    id,
    mutate: (client, recordId) => setLocationActive(client, recordId, active),
    revalidate: ["/localizacoes", `/localizacoes/${id}`],
    successUrl: `/localizacoes/${id}?sucesso=${active ? "ativada" : "desativada"}`,
  });
}
