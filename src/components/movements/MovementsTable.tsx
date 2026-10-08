import Link from "next/link";
import { TableShell, Td, Th } from "@/components/ui/Table";
import { formatDateTime } from "@/lib/format";
import { productLabel } from "@/lib/products/display";
import type { MovementRow } from "@/services/movements";
import { MovementTypeBadge, SignedQuantity } from "./MovementDisplay";

/** Read-only ledger table (no edit/delete actions by design). */
export default function MovementsTable({ rows, showProduct = true }: { rows: MovementRow[]; showProduct?: boolean }) {
  return (
    <TableShell caption="Histórico de movimentações, mais recentes primeiro">
      <thead>
        <tr>
          <Th>Data/hora</Th>
          {showProduct && <Th>Produto</Th>}
          <Th>Tipo</Th>
          <Th className="text-right">Quantidade</Th>
          <Th className="hidden md:table-cell">Projeto</Th>
          <Th className="hidden lg:table-cell">Responsável</Th>
          <Th className="hidden xl:table-cell">Referência</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {rows.map((row) => (
          <tr key={row.id} className="hover:bg-slate-50">
            <Td className="whitespace-nowrap">
              <Link href={`/movimentacoes/${row.id}`} className="font-medium text-brand hover:underline">
                {formatDateTime(row.created_at)}
              </Link>
              <span className="block text-xs text-slate-500 lg:hidden">{row.user?.name ?? "—"}</span>
            </Td>
            {showProduct && (
              <Td>
                <Link href={`/produtos/${row.product.id}`} className="font-mono text-sm font-semibold text-slate-900 hover:underline">
                  {row.product.code}
                </Link>
                <span className="block text-xs text-slate-600">{productLabel(row.product)}</span>
              </Td>
            )}
            <Td>
              <MovementTypeBadge type={row.type} />
            </Td>
            <Td className="text-right">
              <SignedQuantity type={row.type} quantity={row.quantity} unit={row.product.unit} />
            </Td>
            <Td className="hidden md:table-cell">
              {row.project ? (
                <Link href={`/projetos/${row.project.id}`} className="hover:underline">
                  {row.project.name}
                </Link>
              ) : (
                "—"
              )}
            </Td>
            <Td className="hidden lg:table-cell">{row.user?.name ?? "—"}</Td>
            <Td className="hidden break-words xl:table-cell">{row.document_reference ?? "—"}</Td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}
