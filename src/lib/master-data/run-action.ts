import "server-only";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { hasPermission, type Permission } from "@/lib/auth/permissions";
import { requireActiveUser } from "@/lib/auth/session";
import { FORBIDDEN_ERROR } from "@/lib/db/errors";
import { readFields, zodFieldErrors, type FieldDef, type FormState } from "@/lib/forms";
import { createClient } from "@/lib/supabase/server";
import type { DbClient, MutationResult } from "@/services/master-data/shared";

const idSchema = z.uuid();

/**
 * Shared flow for master-data Server Actions:
 * authenticate → UI permission check → Zod validation → mutation as the
 * signed-in user (RLS enforced by PostgreSQL) → revalidate → redirect.
 *
 * The permission check only gives a friendly message early; if it were
 * bypassed, RLS would still reject the write.
 */
export async function runFormAction<Schema extends z.ZodType>(options: {
  formData: FormData;
  fields: readonly FieldDef[];
  schema: Schema;
  mutate: (client: DbClient, input: z.output<Schema>) => Promise<MutationResult>;
  revalidate: string[];
  successUrl: (id: string) => string;
  /** Defaults to master data management. */
  permission?: Permission;
}): Promise<FormState> {
  const user = await requireActiveUser();
  const values = readFields(options.formData, options.fields);
  if (!hasPermission(user.role, options.permission ?? "master_data:manage")) {
    return { status: "error", message: FORBIDDEN_ERROR, values };
  }

  const parsed = options.schema.safeParse(values);
  if (!parsed.success) {
    return {
      status: "error",
      message: "Verifique os campos assinalados.",
      fieldErrors: zodFieldErrors(parsed.error),
      values,
    };
  }

  const result = await options.mutate(await createClient(), parsed.data);
  if (!result.ok) return { status: "error", message: result.message, fieldErrors: result.fieldErrors, values };

  for (const path of options.revalidate) revalidatePath(path);
  redirect(options.successUrl(result.id));
}

/** Same flow for single-purpose actions without form fields (activate/deactivate, status). */
export async function runSimpleAction(options: {
  id: string;
  mutate: (client: DbClient, id: string) => Promise<MutationResult>;
  revalidate: string[];
  successUrl: string;
  permission?: Permission;
}): Promise<FormState> {
  const user = await requireActiveUser();
  if (!hasPermission(user.role, options.permission ?? "master_data:manage")) {
    return { status: "error", message: FORBIDDEN_ERROR };
  }
  if (!idSchema.safeParse(options.id).success) return { status: "error", message: "Registo inválido." };

  const result = await options.mutate(await createClient(), options.id);
  if (!result.ok) return { status: "error", message: result.message };

  for (const path of options.revalidate) revalidatePath(path);
  redirect(options.successUrl);
}

export function isUuid(value: unknown): value is string {
  return idSchema.safeParse(value).success;
}
