"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import TralynLogo from "@/components/brand/TralynLogo";
import type { AppRole } from "@/lib/auth/roles";
import Sidebar from "./Sidebar";
import SignOutButton from "./SignOutButton";
import UserSummary, { type ShellUser } from "./UserSummary";

interface AppShellProps {
  children: React.ReactNode;
  /** Display data only (resolved on the server). Never used for authorization. */
  user: ShellUser & { role: AppRole };
}

const DRAWER_ID = "menu-movel";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function AppShell({ children, user }: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const pathname = usePathname();

  /** Closes the drawer; focus goes back to the menu button unless the close comes from navigation. */
  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, []);

  // Route changed (link inside the drawer, browser back/forward): close without moving focus.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    if (menuOpen) setMenuOpen(false);
  }

  // While open: lock page scroll, move focus inside, trap Tab, close on Escape. Everything is undone on close.
  useEffect(() => {
    if (!menuOpen) return;
    const drawer = drawerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (event.key !== "Tab" || !drawer) return;
      const focusable = Array.from(drawer.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !drawer.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !drawer.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [menuOpen, closeMenu]);

  return (
    <div className="min-h-screen bg-slate-50">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:shadow"
      >
        Saltar para o conteúdo
      </a>

      {/* Desktop: fixed sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-64 lg:block">
        <Sidebar role={user.role} />
      </aside>

      {/* Mobile: drawer (always in the DOM so aria-controls resolves; `hidden` keeps it out of focus and the a11y tree) */}
      <div
        id={DRAWER_ID}
        ref={drawerRef}
        hidden={!menuOpen}
        className="fixed inset-0 z-40 lg:hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
      >
        <div aria-hidden="true" className="absolute inset-0 bg-slate-900/50" data-testid="menu-backdrop" onClick={() => closeMenu(true)} />
        <aside className="relative h-full w-72 max-w-[85%] shadow-xl">
          <Sidebar
            role={user.role}
            onNavigate={() => closeMenu(false)}
            headerAction={
              <button
                ref={closeButtonRef}
                type="button"
                aria-label="Fechar menu"
                onClick={() => closeMenu(true)}
                className="-mr-2 -mt-2 inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-slate-200 hover:bg-slate-800"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" />
                </svg>
                Fechar
              </button>
            }
            footer={
              <div className="flex items-center justify-between gap-3">
                <UserSummary user={user} tone="dark" />
                <SignOutButton className="min-h-11 rounded-md border border-slate-600 px-3 py-1.5 text-sm font-medium text-slate-100 hover:bg-slate-800 disabled:opacity-60" />
              </div>
            }
          />
        </aside>
      </div>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-slate-200 bg-white/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <button
            ref={menuButtonRef}
            type="button"
            className="-ml-2 rounded-md p-2.5 text-slate-700 hover:bg-slate-100 lg:hidden"
            aria-label="Abrir menu"
            aria-expanded={menuOpen}
            aria-controls={DRAWER_ID}
            onClick={() => setMenuOpen(true)}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <TralynLogo size={20} className="lg:hidden" wordmarkClassName="text-slate-900" />

          <div className="ml-auto flex items-center gap-4">
            <div className="hidden sm:block">
              <UserSummary user={user} />
            </div>
            <SignOutButton className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60 max-sm:min-h-11" />
          </div>
        </header>

        <main id="conteudo" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
