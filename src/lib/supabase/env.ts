import { z } from "zod";

/**
 * Public Supabase configuration (safe for the browser).
 *
 * Next.js only inlines NEXT_PUBLIC_* variables that are referenced literally,
 * so each name below must stay a literal `process.env.X` access.
 *
 * The key may be either a new publishable key (sb_publishable_...) or a legacy
 * anon JWT; both are public by design and only grant what RLS allows.
 * NEXT_PUBLIC_SUPABASE_ANON_KEY is accepted as a fallback name.
 */
const publicEnvSchema = z.object({
  url: z.url({ protocol: /^https?$/, error: "NEXT_PUBLIC_SUPABASE_URL deve ser uma URL http(s) válida." }),
  key: z.string().trim().min(20, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY está vazia ou incompleta."),
});

export type SupabasePublicEnv = z.infer<typeof publicEnvSchema>;

export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

export type SupabaseEnvResult =
  | { ok: true; env: SupabasePublicEnv }
  | { ok: false; error: string };

export function parseSupabasePublicEnv(raw: {
  url?: string;
  publishableKey?: string;
  anonKey?: string;
}): SupabaseEnvResult {
  const key = raw.publishableKey?.trim() || raw.anonKey?.trim();
  if (!raw.url?.trim() || !key) {
    return {
      ok: false,
      error:
        "Supabase não configurado: defina NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY em .env.local (ver .env.example).",
    };
  }
  const parsed = publicEnvSchema.safeParse({ url: raw.url.trim(), key });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((issue) => issue.message).join(" ") };
  }
  return { ok: true, env: parsed.data };
}

export function readSupabasePublicEnv(): SupabaseEnvResult {
  return parseSupabasePublicEnv({
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    publishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
}

export function isSupabaseConfigured(): boolean {
  return readSupabasePublicEnv().ok;
}

/** Returns the public config or throws a SupabaseConfigError with an actionable message. */
export function getSupabasePublicEnv(): SupabasePublicEnv {
  const result = readSupabasePublicEnv();
  if (!result.ok) throw new SupabaseConfigError(result.error);
  return result.env;
}
