import type { z } from "zod";

/** State returned by form Server Actions (consumed with useActionState). */
export type FormState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: Record<string, string>; values?: Record<string, string> };

export const INITIAL_FORM_STATE: FormState = { status: "idle" };

export type FieldType = "text" | "email" | "tel" | "number" | "textarea" | "select";

export interface FieldDef {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  maxLength?: number;
  placeholder?: string;
  hint?: string;
  autoComplete?: string;
  /** Visual hint only; the server normalizes the value. */
  uppercase?: boolean;
  options?: readonly { value: string; label: string }[];
  /** For selects: first option with an empty value (e.g. "— Sem localização —"). */
  emptyOption?: string;
  /** Highlighted notice below the field (e.g. the current relation is inactive). */
  warning?: string;
  min?: number;
  /** Grid span on wide screens. */
  wide?: boolean;
}

/** Reads the declared fields from FormData as trimmed-free strings (unknown keys are ignored). */
export function readFields(formData: FormData, fields: readonly FieldDef[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    const value = formData.get(field.name);
    values[field.name] = typeof value === "string" ? value : "";
  }
  return values;
}

/** First error message per top-level field. */
export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "");
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return errors;
}
