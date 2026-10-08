"use client";

import Link from "next/link";
import { useActionState } from "react";
import { buttonClass } from "@/components/ui/Button";
import { INITIAL_FORM_STATE, type FieldDef, type FormState } from "@/lib/forms";

type FormAction = (state: FormState, formData: FormData) => Promise<FormState>;

interface EntityFormProps {
  action: FormAction;
  fields: readonly FieldDef[];
  /** Current record (only the declared fields are used). */
  initialValues?: Record<string, unknown>;
  submitLabel: string;
  cancelHref: string;
}

function toText(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

const inputClass =
  "mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 aria-[invalid=true]:border-red-500";

/**
 * Form for master data records. Validation happens on the server (Zod) and
 * errors come back per field; HTML attributes only improve the UX.
 */
export default function EntityForm({ action, fields, initialValues = {}, submitLabel, cancelHref }: EntityFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const error = state.status === "error" ? state : null;
  const values: Record<string, unknown> = error?.values ?? initialValues;
  // Re-mount inputs after a failed submit so they show the submitted values.
  const version = error ? JSON.stringify(error.values ?? {}) : "initial";

  return (
    <form action={formAction} noValidate aria-busy={pending} className="max-w-3xl space-y-6">
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {error.message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-5 rounded-lg border border-slate-200 bg-white p-5 sm:grid-cols-2">
        {fields.map((field) => {
          const id = `field-${field.name}`;
          const fieldError = error?.fieldErrors?.[field.name];
          const describedBy = [
            field.hint ? `${id}-hint` : null,
            field.warning ? `${id}-warning` : null,
            fieldError ? `${id}-error` : null,
          ]
            .filter(Boolean)
            .join(" ");
          const common = {
            id,
            name: field.name,
            defaultValue: toText(values[field.name]),
            required: field.required,
            maxLength: field.maxLength,
            "aria-invalid": fieldError ? true : undefined,
            "aria-describedby": describedBy || undefined,
            disabled: pending,
            className: inputClass,
          };

          return (
            <div key={`${field.name}-${version}`} className={field.wide ? "sm:col-span-2" : undefined}>
              <label htmlFor={id} className="block text-sm font-medium text-slate-800">
                {field.label}
                {field.required ? (
                  <span className="text-red-700" aria-hidden="true">
                    {" "}
                    *
                  </span>
                ) : (
                  <span className="font-normal text-slate-500"> (opcional)</span>
                )}
              </label>

              {field.type === "textarea" ? (
                <textarea {...common} rows={3} placeholder={field.placeholder} />
              ) : field.type === "select" ? (
                <select {...common}>
                  {field.emptyOption !== undefined && <option value="">{field.emptyOption}</option>}
                  {field.options?.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  {...common}
                  type={field.type ?? "text"}
                  placeholder={field.placeholder}
                  autoComplete={field.autoComplete ?? "off"}
                  style={field.uppercase ? { textTransform: "uppercase" } : undefined}
                  inputMode={
                    field.type === "email" ? "email" : field.type === "tel" ? "tel" : field.type === "number" ? "numeric" : undefined
                  }
                  min={field.type === "number" ? (field.min ?? 0) : undefined}
                  step={field.type === "number" ? 1 : undefined}
                />
              )}

              {field.hint && (
                <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500">
                  {field.hint}
                </p>
              )}
              {field.warning && (
                <p id={`${id}-warning`} className="mt-1 rounded bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900">
                  {field.warning}
                </p>
              )}
              {fieldError && (
                <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
                  {fieldError}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
        <Link href={cancelHref} className={buttonClass("secondary")}>
          Cancelar
        </Link>
        <button type="submit" disabled={pending} className={buttonClass("primary")}>
          {pending ? "A guardar…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
