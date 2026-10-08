import { hasPermission, type Permission } from "@/lib/auth/permissions";
import type { AppRole } from "@/lib/auth/roles";

export interface NavItem {
  href: string;
  label: string;
  /** UI visibility only; the target page and RLS enforce access independently. */
  permission?: Permission;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

/** Routes shown in the app shell. Add entries as each module is implemented. */
export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Operação",
    items: [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/produtos", label: "Produtos" },
      { href: "/movimentacoes", label: "Movimentações" },
    ],
  },
  {
    title: "Cadastros",
    items: [
      { href: "/categorias", label: "Categorias" },
      { href: "/localizacoes", label: "Localizações" },
      { href: "/fornecedores", label: "Fornecedores" },
      { href: "/projetos", label: "Projetos" },
    ],
  },
];

export function navSectionsFor(role: AppRole): NavSection[] {
  return NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !item.permission || hasPermission(role, item.permission)),
  })).filter((section) => section.items.length > 0);
}

export function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
