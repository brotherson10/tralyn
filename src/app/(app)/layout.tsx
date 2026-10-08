import AppShell from "@/components/layout/AppShell";
import { roleLabel } from "@/lib/auth/roles";
import { requireActiveUser } from "@/lib/auth/session";

/**
 * Loads the current user for the shell (name/role display). Each page still
 * calls requireActiveUser() itself, because layouts are not re-rendered on
 * client navigation; data access is authorized by RLS regardless.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireActiveUser();
  return <AppShell user={{ name: user.name, role: user.role, roleLabel: roleLabel(user.role) }}>{children}</AppShell>;
}
