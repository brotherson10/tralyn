import { z } from "zod";

export const loginSchema = z.object({
  email: z
    .string({ error: "Indique o email." })
    .trim()
    .toLowerCase()
    .min(1, "Indique o email.")
    .max(254, "Email demasiado longo.")
    .pipe(z.email("Indique um email válido.")),
  password: z
    .string({ error: "Indique a palavra-passe." })
    .min(1, "Indique a palavra-passe.")
    .max(200, "Palavra-passe demasiado longa."),
});

export type LoginFieldErrors = Partial<Record<"email" | "password", string>>;

export type LoginState =
  | { status: "idle" }
  | { status: "error"; message: string; email: string; fieldErrors?: LoginFieldErrors };

export const INITIAL_LOGIN_STATE: LoginState = { status: "idle" };

export const LOGIN_MESSAGES = {
  invalidCredentials: "Email ou palavra-passe incorretos.",
  rateLimited: "Demasiadas tentativas. Aguarde alguns minutos e tente novamente.",
  unavailable: "Não foi possível iniciar sessão. Tente novamente dentro de instantes.",
  notConfigured: "O sistema ainda não está configurado. Contacte o administrador.",
  inactive: "A sua conta está desativada. Contacte um administrador.",
  invalidProfile: "A sua conta não está configurada corretamente. Contacte um administrador.",
} as const;

/**
 * Maps Supabase Auth errors to safe Portuguese messages.
 *
 * Any error that could reveal whether an email is registered (unknown user,
 * wrong password, unconfirmed email, banned user) gets the same generic
 * message. Internal error text is never shown.
 */
export function loginErrorMessage(error: { code?: string; status?: number } | null | undefined): string {
  if (error?.status === 429 || error?.code === "over_request_rate_limit") return LOGIN_MESSAGES.rateLimited;
  switch (error?.code) {
    case "invalid_credentials":
    case "email_not_confirmed":
    case "user_not_found":
    case "user_banned":
    case "validation_failed":
      return LOGIN_MESSAGES.invalidCredentials;
    default:
      return error?.status === 400 ? LOGIN_MESSAGES.invalidCredentials : LOGIN_MESSAGES.unavailable;
  }
}

/** Messages for /login?motivo=... (keys are fixed; unknown values show nothing). */
export const LOGIN_NOTICES = {
  "conta-inativa": { tone: "error", text: LOGIN_MESSAGES.inactive },
  "perfil-invalido": { tone: "error", text: LOGIN_MESSAGES.invalidProfile },
  "sessao-terminada": { tone: "info", text: "Sessão terminada com sucesso." },
} as const satisfies Record<string, { tone: "error" | "info"; text: string }>;

export type LoginNoticeKey = keyof typeof LOGIN_NOTICES;

export function loginNotice(value: unknown) {
  return typeof value === "string" && Object.hasOwn(LOGIN_NOTICES, value)
    ? LOGIN_NOTICES[value as LoginNoticeKey]
    : null;
}
