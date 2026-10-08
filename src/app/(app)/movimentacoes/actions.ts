"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { operationalMovementTypesFor } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { FORBIDDEN_ERROR } from "@/lib/db/errors";
import { readFields, zodFieldErrors, type FormState } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import { registerMovement } from "@/services/movements";
import { movementSchema } from "@/validation/movements";

const FIELDS = ["product_id", "type", "quantity", "project_id", "document_reference", "notes"].map((name) => ({
  name,
  label: name,
}));

/**
 * Registers a stock movement through the database RPC. The browser never
 * sends a user id, a date or a balance; the RPC takes them from the session
 * and the ledger. Permission checks here only give early, friendly feedback.
 */
export async function registerMovementAction(_state: FormState, formData: FormData): Promise<FormState> {
  const user = await requireActiveUser();
  const values = readFields(formData, FIELDS);
  const allowed = operationalMovementTypesFor(user.role);
  if (allowed.length === 0) return { status: "error", message: FORBIDDEN_ERROR, values };

  const parsed = movementSchema.safeParse(values);
  if (!parsed.success) {
    return { status: "error", message: "Verifique os campos assinalados.", fieldErrors: zodFieldErrors(parsed.error), values };
  }
  if (!allowed.includes(parsed.data.type)) {
    return {
      status: "error",
      message: "O seu perfil não permite registar este tipo de movimentação.",
      fieldErrors: { type: "Tipo de movimentação não permitido para o seu perfil." },
      values,
    };
  }

  const result = await registerMovement(await createClient(), parsed.data);
  if (!result.ok) return { status: "error", message: result.message, fieldErrors: result.fieldErrors, values };

  revalidatePath("/movimentacoes");
  revalidatePath("/produtos");
  revalidatePath(`/produtos/${parsed.data.product_id}`);
  revalidatePath("/dashboard");
  redirect(`/movimentacoes/nova?registada=${result.movementId}`);
}
