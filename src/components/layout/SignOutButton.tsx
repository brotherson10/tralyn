"use client";

import { useFormStatus } from "react-dom";
import { signOutAction } from "@/lib/auth/actions";

function SubmitButton({ className }: { className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className}>
      {pending ? "A sair…" : "Sair"}
    </button>
  );
}

/** POST form bound to a Server Action (CSRF-protected by Next.js origin checks). */
export default function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction}>
      <SubmitButton className={className} />
    </form>
  );
}
