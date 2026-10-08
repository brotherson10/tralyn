"use client";

import { useActionState, useState } from "react";
import { signInAction } from "@/lib/auth/actions";
import { INITIAL_LOGIN_STATE } from "@/lib/auth/login";

export default function LoginForm({ next, disabled }: { next: string | null; disabled?: boolean }) {
  const [state, formAction, pending] = useActionState(signInAction, INITIAL_LOGIN_STATE);
  const [showPassword, setShowPassword] = useState(false);

  const error = state.status === "error" ? state : null;
  const emailError = error?.fieldErrors?.email;
  const passwordError = error?.fieldErrors?.password;
  const locked = pending || disabled;

  return (
    <form action={formAction} noValidate aria-busy={pending} className="mt-6 space-y-4">
      {next && <input type="hidden" name="next" value={next} />}

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error.message}
        </div>
      )}

      <div>
        <label htmlFor="email" className="block text-sm font-medium text-slate-800">
          Email
        </label>
        <input
          // Re-mount after each failed attempt so the typed email is kept.
          key={error ? `email-${error.email}` : "email"}
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          defaultValue={error?.email ?? ""}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? "email-error" : undefined}
          disabled={disabled}
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-slate-900 shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 aria-[invalid=true]:border-red-500"
        />
        {emailError && (
          <p id="email-error" className="mt-1 text-sm text-red-700">
            {emailError}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium text-slate-800">
          Palavra-passe
        </label>
        <div className="relative mt-1">
          <input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            aria-invalid={passwordError ? true : undefined}
            aria-describedby={passwordError ? "password-error" : undefined}
            disabled={disabled}
            className="block w-full rounded-md border border-slate-300 py-2 pl-3 pr-20 text-slate-900 shadow-sm focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/30 aria-[invalid=true]:border-red-500"
          />
          <button
            type="button"
            onClick={() => setShowPassword((value) => !value)}
            aria-pressed={showPassword}
            aria-controls="password"
            disabled={disabled}
            className="absolute inset-y-0 right-0 rounded-r-md px-3 text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            {showPassword ? "Ocultar" : "Mostrar"}
          </button>
        </div>
        {passwordError && (
          <p id="password-error" className="mt-1 text-sm text-red-700">
            {passwordError}
          </p>
        )}
      </div>

      <button
        type="submit"
        disabled={locked}
        className="flex w-full items-center justify-center rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-hover disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "A entrar…" : "Entrar"}
      </button>
    </form>
  );
}
