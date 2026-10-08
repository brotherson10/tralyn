import type { FieldDef } from "@/lib/forms";
import type { Product, ProductFormOptions } from "@/services/products";
import { PRODUCT_UNITS } from "@/validation/products";

/** Field names read by the Server Actions (options are irrelevant there). */
export const PRODUCT_FIELD_NAMES: readonly FieldDef[] = [
  "code",
  "category_id",
  "brand",
  "model",
  "specification",
  "unit",
  "minimum_stock",
  "location_id",
  "default_supplier_id",
].map((name) => ({ name, label: name }));

const INACTIVE_WARNINGS = {
  category: "A categoria atual está inativa. Pode mantê-la neste produto ou escolher uma categoria ativa.",
  location: "A localização atual está inativa. Pode mantê-la neste produto ou escolher uma localização ativa.",
  supplier: "O fornecedor atual está inativo. Pode mantê-lo neste produto ou escolher um fornecedor ativo.",
};

const inactiveWarning = (selected: { inactive: boolean } | undefined, kind: keyof typeof INACTIVE_WARNINGS) =>
  selected?.inactive ? INACTIVE_WARNINGS[kind] : undefined;

/**
 * Product form fields with options loaded from the database. Only active
 * relations are offered, plus the product's current relation when it has
 * since been deactivated (shown and labelled as inactive, never dropped).
 */
export function productFields(options: ProductFormOptions, current: Product | null): FieldDef[] {
  const units = new Set<string>(PRODUCT_UNITS);
  if (current?.unit) units.add(current.unit);

  return [
    {
      name: "code",
      label: "Código",
      required: true,
      maxLength: 17,
      uppercase: true,
      placeholder: "Ex.: INV-201",
      hint: "Formato PREFIXO-NÚMERO, começando pelo prefixo da categoria. É o identificador do produto (etiquetas e futuro QR Code).",
    },
    {
      name: "category_id",
      label: "Categoria",
      type: "select",
      required: true,
      emptyOption: "Selecione a categoria…",
      options: options.categories,
      warning: current
        ? inactiveWarning(options.categories.find((c) => c.value === current.category_id), "category")
        : undefined,
    },
    { name: "brand", label: "Marca", maxLength: 60, placeholder: "Ex.: Northgrid" },
    {
      name: "model",
      label: "Modelo / produto",
      maxLength: 120,
      placeholder: "Ex.: NG-H5",
      hint: "Deixe vazio apenas se o modelo for desconhecido. Indique pelo menos a marca ou o modelo.",
    },
    { name: "specification", label: "Especificação", maxLength: 200, placeholder: "Ex.: 10 kW", wide: true },
    {
      name: "unit",
      label: "Unidade",
      type: "select",
      required: true,
      options: [...units].map((unit) => ({ value: unit, label: unit })),
    },
    {
      name: "minimum_stock",
      label: "Stock mínimo",
      type: "number",
      required: true,
      min: 0,
      hint: "Com saldo igual ou inferior a este valor, o produto passa a “Repor stock”.",
    },
    {
      name: "location_id",
      label: "Localização",
      type: "select",
      emptyOption: "— Sem localização —",
      options: options.locations,
      warning: current
        ? inactiveWarning(options.locations.find((l) => l.value === current.location_id), "location")
        : undefined,
    },
    {
      name: "default_supplier_id",
      label: "Fornecedor padrão",
      type: "select",
      emptyOption: "— Sem fornecedor padrão —",
      options: options.suppliers,
      warning: current
        ? inactiveWarning(options.suppliers.find((s) => s.value === current.default_supplier_id), "supplier")
        : undefined,
    },
  ];
}
