import type { Metadata } from "next";
import EntityForm from "@/components/forms/EntityForm";
import { RecordHeader } from "@/components/master-data/RecordLayout";
import { requirePermission } from "@/lib/auth/session";
import { productFields } from "@/lib/products/fields";
import { createClient } from "@/lib/supabase/server";
import { loadProductFormOptions } from "@/services/products";
import { createProductAction } from "../actions";

export const metadata: Metadata = { title: "Novo produto" };

export default async function NewProductPage() {
  await requirePermission("products:manage");
  const options = await loadProductFormOptions(await createClient(), null);

  return (
    <>
      <RecordHeader
        backHref="/produtos"
        backLabel="Produtos"
        title="Novo produto"
        subtitle="O produto é criado com stock 0. O stock só muda através de movimentações registadas."
      />
      {options.categories.length === 0 ? (
        <div role="status" className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Não existe nenhuma categoria ativa. Crie ou reative uma categoria antes de criar produtos.
        </div>
      ) : (
        <EntityForm
          action={createProductAction}
          fields={productFields(options, null)}
          initialValues={{ unit: "un", minimum_stock: "0" }}
          submitLabel="Criar produto"
          cancelHref="/produtos"
        />
      )}
    </>
  );
}
