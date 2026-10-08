import type { FieldErrors } from "@/lib/db/errors";
import { movementErrorMessage } from "@/lib/stock/movement-errors";
import {
  dayStartInLisbon,
  MOVEMENTS_PAGE_SIZE,
  nextDayStartInLisbon,
  type MovementFilters,
  type MovementInput,
} from "@/validation/movements";
import { failLoad, searchFilter, type DbClient } from "./master-data/shared";

/**
 * Stock movements service.
 *
 * Writes go exclusively through the RPC public.register_stock_movement, which
 * derives the user from the session, timestamps with now(), checks permissions,
 * locks the product row and refuses negative balances. There is no update or
 * delete function: the ledger is append-only.
 */

export type RegisterResult =
  | { ok: true; movementId: string; balanceAfter: number; createdAt: string }
  | { ok: false; message: string; fieldErrors?: FieldErrors };

export async function registerMovement(client: DbClient, input: MovementInput): Promise<RegisterResult> {
  const { data, error } = await client.rpc("register_stock_movement", {
    p_product_id: input.product_id,
    p_type: input.type,
    p_quantity: input.quantity,
    // The RPC treats omitted optional arguments as NULL.
    ...(input.project_id ? { p_project_id: input.project_id } : {}),
    ...(input.document_reference ? { p_document_reference: input.document_reference } : {}),
    ...(input.notes ? { p_notes: input.notes } : {}),
  });

  if (error || !data?.[0]) {
    let unit = "un";
    if (error?.message === "INSUFFICIENT_STOCK") {
      const { data: product } = await client.from("product_stock").select("unit").eq("id", input.product_id).maybeSingle();
      unit = product?.unit ?? unit;
    }
    if (error && !KNOWN_RPC_ERRORS.has(error.message)) {
      console.error("[movements] register failed", { code: error.code });
    }
    return { ok: false, ...movementErrorMessage(error ?? {}, unit) };
  }

  const row = data[0];
  return { ok: true, movementId: row.movement_id, balanceAfter: row.balance_after, createdAt: row.movement_created_at };
}

const KNOWN_RPC_ERRORS = new Set([
  "INSUFFICIENT_STOCK",
  "PRODUCT_INACTIVE",
  "PRODUCT_NOT_FOUND",
  "PROJECT_NOT_FOUND",
  "PROJECT_NOT_ACTIVE",
  "INVALID_QUANTITY",
  "INVALID_INPUT",
  "FORBIDDEN",
  "NOT_AUTHENTICATED",
  "OPENING_BALANCE_EXISTS",
]);

// -----------------------------------------------------------------------------
// Reads (one query with embedded product / project / responsible user: no N+1)
// -----------------------------------------------------------------------------
const MOVEMENT_COLUMNS = `
  id, type, quantity, document_reference, notes, created_at, product_id, project_id,
  product:products!inner(id, code, brand, model, unit, active),
  project:projects(id, name, reference, status),
  user:profiles(id, name)
`;

export async function listMovements(
  client: DbClient,
  filters: Partial<MovementFilters> = {},
  pageSize = MOVEMENTS_PAGE_SIZE,
) {
  const page = filters.page ?? 1;
  let query = client.from("stock_movements").select(MOVEMENT_COLUMNS, { count: "exact" });

  if (filters.q) {
    query = query.or(`code.ilike.%${filters.q}%,brand.ilike.%${filters.q}%,model.ilike.%${filters.q}%`, {
      referencedTable: "products",
    });
  }
  if (filters.type) query = query.eq("type", filters.type);
  if (filters.productId) query = query.eq("product_id", filters.productId);
  if (filters.projectId) query = query.eq("project_id", filters.projectId);
  if (filters.from) query = query.gte("created_at", dayStartInLisbon(filters.from));
  if (filters.to) query = query.lt("created_at", nextDayStartInLisbon(filters.to));

  const start = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(start, start + pageSize - 1);

  // Page beyond the end of the result set.
  if (error?.code === "PGRST103") return { rows: [], total: count ?? 0, page, pageSize, outOfRange: true };
  if (error) failLoad("as movimentações", error);
  return { rows: data, total: count ?? data.length, page, pageSize, outOfRange: false };
}

export type MovementRow = Awaited<ReturnType<typeof listMovements>>["rows"][number];

export async function getMovement(client: DbClient, id: string): Promise<MovementRow | null> {
  const { data, error } = await client.from("stock_movements").select(MOVEMENT_COLUMNS).eq("id", id).maybeSingle();
  if (error) failLoad("a movimentação", error);
  return data;
}

// -----------------------------------------------------------------------------
// Form options: only active products and active projects are offered
// -----------------------------------------------------------------------------
export const MOVEMENT_PRODUCT_OPTIONS_LIMIT = 100;

const FORM_PRODUCT_COLUMNS = "id, code, brand, model, specification, unit, balance, minimum_stock, status";

/**
 * Active products for the form, searched on the server (code/brand/model) and
 * capped, so the page stays usable however large the catalogue grows. The
 * preselected product (e.g. coming from the product page) is always included
 * when it is active.
 */
export async function loadMovementFormOptions(
  client: DbClient,
  options: { search?: string; includeProductId?: string | null } = {},
) {
  let productQuery = client
    .from("product_stock")
    .select(FORM_PRODUCT_COLUMNS, { count: "exact" })
    .eq("active", true)
    .order("code")
    .limit(MOVEMENT_PRODUCT_OPTIONS_LIMIT);
  if (options.search) productQuery = productQuery.or(searchFilter(["code", "brand", "model"], options.search));

  const [products, projects, included] = await Promise.all([
    productQuery,
    client.from("projects").select("id, name, reference, client").eq("status", "active").order("name").limit(1000),
    options.includeProductId
      ? client.from("product_stock").select(FORM_PRODUCT_COLUMNS).eq("id", options.includeProductId).eq("active", true).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (products.error) failLoad("os produtos", products.error);
  if (projects.error) failLoad("os projetos", projects.error);

  const rows = [...products.data];
  if (included.data && !rows.some((row) => row.id === included.data?.id)) rows.unshift(included.data);

  // View columns are typed as nullable; rows from product_stock always have them.
  const formProducts: MovementFormProduct[] = rows.flatMap((p) =>
    p.id && p.code
      ? [
          {
            id: p.id,
            code: p.code,
            brand: p.brand,
            model: p.model,
            specification: p.specification,
            unit: p.unit ?? "un",
            balance: p.balance ?? 0,
            minimum_stock: p.minimum_stock ?? 0,
            status: p.status,
          },
        ]
      : [],
  );
  return {
    products: formProducts,
    projects: projects.data as MovementFormProject[],
    matchingProducts: products.count ?? formProducts.length,
  };
}

export interface MovementFormProduct {
  id: string;
  code: string;
  brand: string | null;
  model: string | null;
  specification: string | null;
  unit: string;
  balance: number;
  minimum_stock: number;
  status: string | null;
}

export interface MovementFormProject {
  id: string;
  name: string;
  reference: string | null;
  client: string | null;
}
