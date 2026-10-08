import { z } from "zod";
import { STOCK_STATUSES, type StockStatus } from "@/lib/stock/status";
import { ACTIVE_FILTERS, type ActiveFilter } from "./master-data";

/**
 * Product form validation (server-side). Mirrors the columns of
 * public.products; stock is NOT part of a product (it is derived from the
 * ledger), so there is no stock field here.
 */

/** Business code: <PREFIX>-<number>, e.g. INV-201, EVC-412. */
export const PRODUCT_CODE_PATTERN = /^[A-Z0-9]{2,10}-[0-9]{3,6}$/;

/** Units offered by the legacy workbook's data validation list. */
export const PRODUCT_UNITS = ["un", "kit", "caixa", "rolo", "m", "par"] as const;

export const BRAND_OR_MODEL_MESSAGE = "Indique pelo menos a marca ou o modelo.";

const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

const optionalText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : collapse(value) || null))
    .pipe(z.string().max(max, `Máximo de ${max} caracteres.`).nullable());

const optionalId = (message: string) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null || value.trim() === "" ? null : value.trim()))
    .pipe(z.uuid(message).nullable());

export const productSchema = z.object({
  // Codes are identifiers: trimming and uppercasing is a safe normalization.
  code: z
    .string({ error: "Indique o código." })
    .transform((value) => value.trim().toUpperCase())
    .pipe(
      z
        .string()
        .min(1, "Indique o código.")
        .regex(PRODUCT_CODE_PATTERN, "Use o formato PREFIXO-NÚMERO, por exemplo INV-201."),
    ),
  category_id: z
    .string({ error: "Escolha a categoria." })
    .trim()
    .min(1, "Escolha a categoria.")
    .pipe(z.uuid("Escolha uma categoria válida.")),
  // Brand and model are only trimmed (inner spacing collapsed), never re-cased.
  // Blank → NULL: a missing value is NULL, never placeholder text.
  brand: optionalText(60),
  // Optional: some products have no known model (only the brand is known).
  model: optionalText(120),
  specification: optionalText(200),
  unit: z
    .string({ error: "Escolha a unidade." })
    .transform(collapse)
    .pipe(z.string().min(1, "Escolha a unidade.").max(20, "Máximo de 20 caracteres.")),
  minimum_stock: z
    .string({ error: "Indique o stock mínimo." })
    .trim()
    .min(1, "Indique o stock mínimo.")
    .regex(/^-?\d+$/, "Indique um número inteiro.")
    .transform(Number)
    .pipe(
      z
        .number()
        .int("Indique um número inteiro.")
        .min(0, "O stock mínimo não pode ser negativo.")
        .max(1_000_000, "Valor demasiado alto."),
    ),
  location_id: optionalId("Escolha uma localização válida."),
  default_supplier_id: optionalId("Escolha um fornecedor válido."),
}).check(
  // A product must remain identifiable: brand OR model (same rule as the
  // products_brand_or_model_present constraint). Runs even when other fields
  // have errors, so the message appears on the first attempt.
  z.superRefine(
    (value, ctx) => {
      if (!value.brand && !value.model) {
        for (const path of ["brand", "model"]) {
          ctx.addIssue({ code: "custom", path: [path], message: BRAND_OR_MODEL_MESSAGE });
        }
      }
    },
    { when: (payload) => typeof payload.value === "object" && payload.value !== null },
  ),
);

export type ProductInput = z.output<typeof productSchema>;

/** Codes must start with the category prefix (e.g. category INV → INV-201). */
export function codeMatchesPrefix(code: string, prefix: string): boolean {
  return code.startsWith(`${prefix}-`);
}

// -----------------------------------------------------------------------------
// List filters (URL query string)
// -----------------------------------------------------------------------------
export interface ProductFilters {
  q: string;
  categoryId: string | null;
  /** A location id, or "sem" for products without a location. */
  location: string | null;
  active: ActiveFilter;
  stock: StockStatus | "todos";
}

const uuid = z.uuid();

export function parseProductFilters(params: Record<string, unknown>, sanitize: (value: unknown) => string): ProductFilters {
  const categoria = params.categoria;
  const localizacao = params.localizacao;
  return {
    q: sanitize(params.q),
    categoryId: uuid.safeParse(categoria).success ? (categoria as string) : null,
    location:
      localizacao === "sem" ? "sem" : uuid.safeParse(localizacao).success ? (localizacao as string) : null,
    active: (ACTIVE_FILTERS as readonly unknown[]).includes(params.estado) ? (params.estado as ActiveFilter) : "todos",
    stock: (STOCK_STATUSES as readonly unknown[]).includes(params.stock) ? (params.stock as StockStatus) : "todos",
  };
}
