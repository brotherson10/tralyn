import type { Metadata } from "next";
import Link from "next/link";
import PageHeader from "@/components/ui/PageHeader";
import { requireActiveUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Sem permissão" };

export default async function NoPermissionPage() {
  await requireActiveUser();
  return (
    <>
      <PageHeader title="Sem permissão" description="O seu perfil não permite aceder a esta área." />
      <Link href="/dashboard" className="text-sm font-medium text-brand underline hover:text-brand-hover">
        Voltar ao dashboard
      </Link>
    </>
  );
}
