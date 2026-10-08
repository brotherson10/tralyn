import type { Metadata } from "next";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader } from "@/components/master-data/RecordLayout";
import { requirePermission } from "@/lib/auth/session";
import { SUPPLIER_FIELDS } from "@/lib/master-data/fields";
import { createSupplierAction } from "../actions";

export const metadata: Metadata = { title: "Novo fornecedor" };

export default async function NewSupplierPage() {
  await requirePermission("master_data:manage");
  return (
    <>
      <RecordHeader backHref="/fornecedores" backLabel="Fornecedores" title="Novo fornecedor" />
      <EntityForm
        action={createSupplierAction}
        fields={SUPPLIER_FIELDS}
        submitLabel="Criar fornecedor"
        cancelHref="/fornecedores"
      />
    </>
  );
}
