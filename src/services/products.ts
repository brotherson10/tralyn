import type { FieldErrors } from "@/lib/db/errors";
import { CHECK_FIELDS_ERROR, NOT_FOUND_OR_FORBIDDEN_ERROR } from "@/lib/db/errors";
import type { Tables } from "@/types/database";
import { codeMatchesPrefix, type ProductFilters, type ProductInput } from "@/validation/products";
import {
  failLoad,
  searchFilter,
  toMutationResult,
  type DbClient,
  type MutationResult,
} from "./master-data/shared";

/**
 * Products service.
 *
 * Stock is never read from or written to public.products: balance and status
 * come from the view public.product_stock (derived from the ledger). Creating,
 * editing or (de)activating a product never touches stock_movements.
 */

export type Product = Tables<"products">;
export type ProductStock = Tables<"product_stock">;

const STOCK_COLUMNS =
  "id, code, category_id, category_name, category_prefix, brand, model, specification, unit, minimum_stock, location_id, location_code, default_supplier_id, supplier_name, qr_code, active, created_at, updated_at, balance, status, last_movement_at";

const PRODUCT_COLUMNS =
  "id, code, category_id, brand, model, specification, unit, minimum_stock, location_id, default_supplier_id, qr_code, active, created_at, updated_at";

export async function listProducts(client: DbClient, filters: Partial<ProductFilters> = {}): Promise<ProductStock[]> {
  let query = client.from("product_stock").select(STOCK_COLUMNS).order("code").limit(1000);
  if (filters.q) query = query.or(searchFilter(["code", "brand", "model", "specification"], filters.q));
  if (filters.categoryId) query = query.eq("category_id", filters.categoryId);
  if (filters.location === "sem") query = query.is("location_id", null);
  else if (filters.location) query = query.eq("location_id", filters.location);
  if (filters.active === "ativos") query = query.eq("active", true);
  if (filters.active === "inativos") query = query.eq("active", false);
  if (filters.stock && filters.stock !== "todos") query = query.eq("status", filters.stock);

  const { data, error } = await query;
  if (error) failLoad("os produtos", error);
  return data;
}

/** Product with related names, balance and status (read model for pages). */
export async function getProductStock(client: DbClient, id: string): Promise<ProductStock | null> {
  const { data, error } = await client.from("product_stock").select(STOCK_COLUMNS).eq("id", id).maybeSingle();
  if (error) failLoad("o produto", error);
  return data;
}

/** Raw product row (write model, used to prefill the edit form). */
export async function getProduct(client: DbClient, id: string): Promise<Product | null> {
  const { data, error } = await client.from("products").select(PRODUCT_COLUMNS).eq("id", id).maybeSingle();
  if (error) failLoad("o produto", error);
  return data;
}

// -----------------------------------------------------------------------------
// Relation rules (not enforced by the schema, so enforced here):
// - new products may only use ACTIVE categories, locations and suppliers;
// - an existing product may KEEP a relation that became inactive later, but
//   may not be switched to another inactive one;
// - the code must start with the category prefix when the code or the
//   category changes (legacy/unchanged codes are left alone).
// -----------------------------------------------------------------------------
async function checkRelations(client: DbClient, input: ProductInput, current: Product | null): Promise<FieldErrors> {
  const errors: FieldErrors = {};

  const { data: category } = await client
    .from("categories")
    .select("id, prefix, active")
    .eq("id", input.category_id)
    .maybeSingle();
  if (!category) {
    errors.category_id = "A categoria escolhida não existe.";
  } else {
    if (!category.active && category.id !== current?.category_id) {
      errors.category_id = "Esta categoria está inativa. Escolha uma categoria ativa.";
    }
    const codeOrCategoryChanged = !current || current.code !== input.code || current.category_id !== input.category_id;
    if (codeOrCategoryChanged && !codeMatchesPrefix(input.code, category.prefix)) {
      errors.code = `O código deve começar pelo prefixo da categoria: ${category.prefix}-`;
    }
  }

  if (input.location_id) {
    const { data: location } = await client
      .from("locations")
      .select("id, active")
      .eq("id", input.location_id)
      .maybeSingle();
    if (!location) errors.location_id = "A localização escolhida não existe.";
    else if (!location.active && location.id !== current?.location_id) {
      errors.location_id = "Esta localização está inativa. Escolha uma localização ativa.";
    }
  }

  if (input.default_supplier_id) {
    const { data: supplier } = await client
      .from("suppliers")
      .select("id, active")
      .eq("id", input.default_supplier_id)
      .maybeSingle();
    if (!supplier) errors.default_supplier_id = "O fornecedor escolhido não existe.";
    else if (!supplier.active && supplier.id !== current?.default_supplier_id) {
      errors.default_supplier_id = "Este fornecedor está inativo. Escolha um fornecedor ativo.";
    }
  }

  return errors;
}

function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

export async function createProduct(client: DbClient, input: ProductInput): Promise<MutationResult> {
  const errors = await checkRelations(client, input, null);
  if (hasErrors(errors)) return { ok: false, message: CHECK_FIELDS_ERROR, fieldErrors: errors };
  // Only product columns are written. No stock movement is created.
  return toMutationResult(await client.from("products").insert(input).select("id").single());
}

export async function updateProduct(client: DbClient, id: string, input: ProductInput): Promise<MutationResult> {
  const current = await getProduct(client, id);
  if (!current) return { ok: false, message: NOT_FOUND_OR_FORBIDDEN_ERROR };

  const errors = await checkRelations(client, input, current);
  if (hasErrors(errors)) return { ok: false, message: CHECK_FIELDS_ERROR, fieldErrors: errors };
  return toMutationResult(await client.from("products").update(input).eq("id", id).select("id").single());
}

export async function setProductActive(client: DbClient, id: string, active: boolean): Promise<MutationResult> {
  return toMutationResult(await client.from("products").update({ active }).eq("id", id).select("id").single());
}

// -----------------------------------------------------------------------------
// Options for the product form (active records + the current, possibly inactive, one)
// -----------------------------------------------------------------------------
export interface RelationOption {
  value: string;
  label: string;
  inactive: boolean;
}

export interface ProductFormOptions {
  categories: (RelationOption & { prefix: string })[];
  locations: RelationOption[];
  suppliers: RelationOption[];
}

export async function loadProductFormOptions(client: DbClient, current: Product | null): Promise<ProductFormOptions> {
  const [categories, locations, suppliers] = await Promise.all([
    client.from("categories").select("id, name, prefix, active").order("name"),
    client.from("locations").select("id, code, description, active").order("code"),
    client.from("suppliers").select("id, name, active").order("name"),
  ]);
  if (categories.error) failLoad("as categorias", categories.error);
  if (locations.error) failLoad("as localizações", locations.error);
  if (suppliers.error) failLoad("os fornecedores", suppliers.error);

  const keep = (row: { id: string; active: boolean }, currentId: string | null | undefined) =>
    row.active || row.id === currentId;

  return {
    categories: categories.data
      .filter((row) => keep(row, current?.category_id))
      .map((row) => ({
        value: row.id,
        label: `${row.name} (${row.prefix})${row.active ? "" : " — inativa"}`,
        prefix: row.prefix,
        inactive: !row.active,
      })),
    locations: locations.data
      .filter((row) => keep(row, current?.location_id))
      .map((row) => ({
        value: row.id,
        label: `${row.code}${row.description ? ` — ${row.description}` : ""}${row.active ? "" : " (inativa)"}`,
        inactive: !row.active,
      })),
    suppliers: suppliers.data
      .filter((row) => keep(row, current?.default_supplier_id))
      .map((row) => ({ value: row.id, label: `${row.name}${row.active ? "" : " (inativo)"}`, inactive: !row.active })),
  };
}
