"use client";

import { useActionState, useRef, useState } from "react";
import { buttonClass } from "@/components/ui/Button";
import { signInAction } from "@/lib/auth/actions";
import { INITIAL_LOGIN_STATE } from "@/lib/auth/login";
import type { PublicDemoViewer } from "@/lib/demo/public-demo";

const DEMO_FILLED_MESSAGE = "Credenciais de demonstração preenchidas. Carregue em Entrar para continuar.";

export default function LoginForm({
  next,
  disabled,
  demo = null,
}: {
  next: string | null;
  disabled?: boolean;
  /** Public read-only demo account; the block is only rendered when provided. */
  demo?: PublicDemoViewer | null;
}) {
  const [state, formAction, pending] = useActionState(signInAction, INITIAL_LOGIN_STATE);
  const [showPassword, setShowPassword] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  const error = state.status === "error" ? state : null;
  const emailError = error?.fieldErrors?.email;
  const passwordError = error?.fieldErrors?.password;
  const locked = pending || disabled;
  const showDemo = demo !== null && !disabled;

  // Fills the uncontrolled fields only; signing in stays an explicit "Entrar".
  function fillDemo() {
    if (!demo || !emailRef.current || !passwordRef.current) return;
    emailRef.current.value = demo.email;
    passwordRef.current.value = demo.password;
    setAnnouncement("");
    // Re-set on the next frame so screen readers announce repeated clicks too.
    requestAnimationFrame(() => setAnnouncement(DEMO_FILLED_MESSAGE));
    submitRef.current?.focus();
  }

  return (
    <>
      {showDemo && (
        <section
          aria-labelledby="demo-heading"
          className="mt-6 rounded-lg border border-brand/20 bg-brand/5 p-4"
        >
          <h2 id="demo-heading" className="text-sm font-semibold text-slate-900">
            Demonstração pública
          </h2>
          <p className="mt-1 text-sm text-slate-700">
            <strong className="font-semibold">Acesso de leitura — dados fictícios.</strong> Explore stock, movimentos e
            projetos sem criar conta.
          </p>
          <button
            type="button"
            onClick={fillDemo}
            disabled={pending}
            aria-describedby="demo-status"
            className={buttonClass("secondary", "mt-3 w-full border-brand/40 text-brand hover:bg-white")}
          >
            Explorar demonstração
          </button>
          <p id="demo-status" aria-live="polite" className="mt-2 text-xs text-slate-600 empty:hidden">
            {announcement}
          </p>
        </section>
      )}

      {showDemo && (
        <div className="mt-6 flex items-center gap-3 text-xs text-slate-500" aria-hidden="true">
          <span className="h-px flex-1 bg-slate-200" />
          ou entre com a sua conta
          <span className="h-px flex-1 bg-slate-200" />
        </div>
      )}

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
            ref={emailRef}
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            // With the demo block first, keyboard and mobile users start there.
            autoFocus={!showDemo}
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
              ref={passwordRef}
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
          ref={submitRef}
          type="submit"
          disabled={locked}
          className="flex w-full items-center justify-center rounded-md bg-brand px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "A entrar…" : "Entrar"}
        </button>
      </form>
    </>
  );
}
