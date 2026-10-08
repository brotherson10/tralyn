import type { Metadata } from "next";
import { TralynSymbol } from "@/components/brand/TralynLogo";
import ConfigNotice from "@/components/layout/ConfigNotice";
import { loginNotice } from "@/lib/auth/login";
import { safeNextPath } from "@/lib/auth/routing";
import { isSupabaseConfigured } from "@/lib/supabase/env";
import LoginForm from "./LoginForm";

export const metadata: Metadata = { title: "Entrar" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const notice = loginNotice(params.motivo);
  const next = safeNextPath(params.next);
  const configured = isSupabaseConfigured();

  return (
    <div className="rounded-xl bg-white p-8 shadow-xl">
      <div className="flex items-center gap-3">
        <TralynSymbol size={40} className="text-brand" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight text-slate-900">Tralyn</h1>
          <p className="text-sm text-slate-600">Gestão de inventário de armazém</p>
        </div>
      </div>
      <p lang="en" className="mt-3 text-xs font-medium text-slate-500">
        Inventory, built around traceability.
      </p>
      <p className="mt-6 text-sm text-slate-600">Inicie sessão para aceder à gestão do armazém.</p>

      {!configured && (
        <div className="mt-6">
          <ConfigNotice />
        </div>
      )}

      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`mt-6 rounded-md border px-3 py-2 text-sm ${
            notice.tone === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-900"
          }`}
        >
          {notice.text}
        </div>
      )}

      <LoginForm next={next} disabled={!configured} />

      <p className="mt-6 text-xs text-slate-500">
        O acesso é concedido pelo administrador. Não existe registo público.
      </p>
    </div>
  );
}
