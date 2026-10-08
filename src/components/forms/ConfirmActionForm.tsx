"use client";

import { useActionState, useState } from "react";
import { buttonClass, type ButtonVariant } from "@/components/ui/Button";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms";

interface ConfirmActionFormProps {
  action: (state: FormState, formData: FormData) => Promise<FormState>;
  label: string;
  /** Question shown in the confirmation step. */
  confirmMessage: string;
  confirmLabel: string;
  variant?: ButtonVariant;
}

/**
 * Two-step action (e.g. deactivate): the first click reveals an inline
 * confirmation instead of a modal or window.confirm(), which keeps keyboard
 * and screen-reader flow simple.
 */
export default function ConfirmActionForm({
  action,
  label,
  confirmMessage,
  confirmLabel,
  variant = "secondary",
}: ConfirmActionFormProps) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div>
        <button type="button" className={buttonClass(variant)} onClick={() => setConfirming(true)}>
          {label}
        </button>
        {state.status === "error" && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {state.message}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      action={formAction}
      role="group"
      aria-label={confirmMessage}
      className="rounded-md border border-amber-300 bg-amber-50 p-4"
    >
      <p className="text-sm font-medium text-amber-900">{confirmMessage}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="submit" disabled={pending} className={buttonClass(variant === "danger" ? "danger" : "primary")} autoFocus>
          {pending ? "A processar…" : confirmLabel}
        </button>
        <button type="button" disabled={pending} className={buttonClass("secondary")} onClick={() => setConfirming(false)}>
          Cancelar
        </button>
      </div>
      {state.status === "error" && (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {state.message}
        </p>
      )}
    </form>
  );
}
