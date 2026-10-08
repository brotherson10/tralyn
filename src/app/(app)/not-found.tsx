import Link from "next/link";
import EmptyState from "@/components/ui/EmptyState";

export default function NotFound() {
  return (
    <EmptyState
      title="Registo não encontrado"
      description="O registo pedido não existe ou deixou de estar disponível."
      action={
        <Link href="/dashboard" className="text-sm font-medium text-brand underline hover:text-brand-hover">
          Voltar ao dashboard
        </Link>
      }
    />
  );
}
