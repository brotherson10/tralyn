"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import TralynLogo from "@/components/brand/TralynLogo";
import type { AppRole } from "@/lib/auth/roles";
import { isActive, navSectionsFor } from "./nav";

interface SidebarProps {
  role: AppRole;
  /** Called after a link is followed, so the mobile drawer can close. */
  onNavigate?: () => void;
  footer?: React.ReactNode;
  /** Rendered next to the brand (e.g. the drawer's close button). */
  headerAction?: React.ReactNode;
}

export default function Sidebar({ role, onNavigate, footer, headerAction }: SidebarProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-slate-900 text-slate-100">
      <div className="flex items-start justify-between gap-2 border-b border-slate-800 px-5 py-5">
        <Link href="/dashboard" onClick={onNavigate} className="block min-w-0 rounded-md">
          <TralynLogo size={22} symbolClassName="text-brand-on-dark" wordmarkClassName="text-lg text-white" />
          <span className="mt-0.5 block pl-[30px] text-xs text-slate-400">Gestão do armazém</span>
        </Link>
        {headerAction}
      </div>

      <nav aria-label="Navegação principal" className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        {navSectionsFor(role).map((section) => (
          <div key={section.title}>
            <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{section.title}</p>
            <ul className="space-y-1">
              {section.items.map((item) => {
                const active = isActive(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center rounded-md px-3 py-2 text-sm font-medium transition-colors max-lg:min-h-11 ${
                        active ? "bg-slate-800 text-white" : "text-slate-300 hover:bg-slate-800/60 hover:text-white"
                      }`}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {footer && <div className="border-t border-slate-800 px-5 py-4">{footer}</div>}
    </div>
  );
}
