import { isSupabaseConfigured } from "@/lib/supabase/env";

/** Shown on the login page while .env.local has no Supabase configuration. */
export default function ConfigNotice() {
  if (isSupabaseConfigured()) return null;
  return (
    <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-semibold">Supabase ainda não está configurado.</p>
      <p className="mt-1">
        Copie <code className="rounded bg-amber-100 px-1">.env.example</code> para{" "}
        <code className="rounded bg-amber-100 px-1">.env.local</code>, preencha a URL e a chave pública do
        projeto e reinicie o servidor.
      </p>
    </div>
  );
}
