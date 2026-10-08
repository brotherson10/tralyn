import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMovement, listMovements, loadMovementFormOptions, registerMovement } from "@/services/movements";
import type { MutationResult } from "@/services/master-data/shared";
import { createProduct, getProduct, getProductStock, listProducts, updateProduct } from "@/services/products";
import { movementSchema } from "@/validation/movements";
import { BRAND_OR_MODEL_MESSAGE, productSchema } from "@/validation/products";
import { closeDb, createUser, db, pgError, signIn, uid, type Client } from "./helpers";

/**
 * products.model may be NULL (unknown model), but a product always keeps a
 * brand or a model, and neither may be blank text. Superuser inserts prove the
 * database constraints; service calls prove the application flow (RLS on).
 */

let admin: Client;
let inv: string; // category created for this run (unique prefix → unique product codes)
let prefix: string;

beforeAll(async () => {
  admin = await signIn(await createUser("admin"));
  prefix = `M${uid().replace(/[^A-Z0-9]/g, "").slice(0, 6)}`;
  const { rows } = await db().query<{ id: string }>(
    `insert into public.categories (name, prefix) values ($1, $2) returning id`,
    [`Modelo opcional ${prefix}`, prefix],
  );
  inv = rows[0].id;
});

afterAll(closeDb);

let sequence = 0;
const nextCode = () => `${prefix}-${String((sequence += 1)).padStart(3, "0")}`;

async function insertRaw(brand: string | null, model: string | null): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    `insert into public.products (code, category_id, brand, model) values ($1, $2, $3, $4) returning id`,
    [nextCode(), inv, brand, model],
  );
  return rows[0].id;
}

function ok(result: MutationResult): string {
  if (!result.ok) throw new Error(`expected success: ${result.message} ${JSON.stringify(result.fieldErrors)}`);
  return result.id;
}

const input = (fields: Record<string, string | null>) =>
  productSchema.parse({ code: nextCode(), category_id: inv, unit: "un", minimum_stock: "1", ...fields });

describe("database constraints", () => {
  it("A) brand = 'Voltaris', model = NULL → accepted", async () => {
    const id = await insertRaw("Voltaris", null);
    const { rows } = await db().query(`select brand, model from public.products where id = $1`, [id]);
    expect(rows[0]).toEqual({ brand: "Voltaris", model: null });
  });

  it("B) brand = NULL, model = 'ABC' → accepted", async () => {
    expect(await insertRaw(null, "ABC")).toBeTruthy();
  });

  it("C) brand = NULL, model = NULL → rejected by products_brand_or_model_present", async () => {
    const error = await pgError(() => insertRaw(null, null));
    expect(error.code).toBe("23514");
    expect(error.message).toContain("products_brand_or_model_present");
  });

  it.each([
    ["D) brand = ''", "", "ABC", "products_brand_not_blank"],
    ["E) brand = '   '", "   ", "ABC", "products_brand_not_blank"],
    ["F) model = ''", "Voltaris", "", "products_model_not_blank"],
    ["G) model = '   '", "Voltaris", "   ", "products_model_not_blank"],
  ])("%s → rejected by %s", async (_label, brand, model, constraint) => {
    const error = await pgError(() => insertRaw(brand, model));
    expect(error.code).toBe("23514");
    expect(error.message).toContain(constraint);
  });

  it("D–G) the application normalizes blank brand/model to NULL instead of storing them", async () => {
    const id = ok(await createProduct(admin, input({ brand: "  Voltaris  ", model: "   " })));
    expect(await getProduct(admin, id)).toMatchObject({ brand: "Voltaris", model: null });
  });
});

describe("reads, movements and search with model = NULL", () => {
  let id: string;
  let code: string;
  const brand = `Voltaris${uid()}`;

  beforeAll(async () => {
    id = ok(await createProduct(admin, input({ brand, model: "" })));
    code = (await getProduct(admin, id))!.code;
  });

  it("H) product_stock works with model NULL", async () => {
    expect(await getProductStock(admin, id)).toMatchObject({ code, brand, model: null, balance: 0, status: "OUT_OF_STOCK" });
  });

  it("I) IN / OUT / adjustments work and the history shows the product", async () => {
    const register = (type: string, quantity: number, notes?: string) =>
      registerMovement(admin, movementSchema.parse({ product_id: id, type, quantity: String(quantity), ...(notes ? { notes } : {}) }));

    expect(await register("IN", 5)).toMatchObject({ ok: true, balanceAfter: 5 });
    expect(await register("OUT", 2)).toMatchObject({ ok: true, balanceAfter: 3 });
    expect(await register("ADJUSTMENT_IN", 1, "Contagem")).toMatchObject({ ok: true, balanceAfter: 4 });
    const last = await register("ADJUSTMENT_OUT", 4, "Conferência");
    expect(last).toMatchObject({ ok: true, balanceAfter: 0 });

    const history = await listMovements(admin, { productId: id });
    expect(history.total).toBe(4);
    expect(history.rows[0].product).toMatchObject({ code, brand, model: null });
    expect((await getMovement(admin, last.ok ? last.movementId : ""))?.product.model).toBeNull();
  });

  it("J) search by code and by brand finds it (lists and movement form)", async () => {
    expect((await listProducts(admin, { q: code })).map((p) => p.id)).toEqual([id]);
    expect((await listProducts(admin, { q: brand })).map((p) => p.id)).toEqual([id]);
    const options = await loadMovementFormOptions(admin, { search: brand });
    expect(options.products).toEqual([expect.objectContaining({ id, code, brand, model: null })]);
  });
});

describe("application flow (services + validation)", () => {
  it("admin creates a product with brand only and with model only", async () => {
    expect(ok(await createProduct(admin, input({ brand: "Gridora", model: "" })))).toBeTruthy();
    expect(ok(await createProduct(admin, input({ brand: "", model: "Wallbox Pulsar" })))).toBeTruthy();
  });

  it("without brand and model: validation message; and the database still refuses if validation is bypassed", async () => {
    const parsed = productSchema.safeParse({ code: nextCode(), category_id: inv, unit: "un", minimum_stock: "1" });
    expect(parsed.success).toBe(false);

    const bypass = await createProduct(admin, { ...input({ brand: "X" }), brand: null, model: null });
    expect(bypass).toMatchObject({ ok: false, fieldErrors: { model: BRAND_OR_MODEL_MESSAGE } });
  });

  it("editing may remove the model while the brand stays, but not both", async () => {
    const id = ok(await createProduct(admin, input({ brand: "Northgrid", model: "20K" })));
    const current = (await getProduct(admin, id))!;

    ok(await updateProduct(admin, id, productSchema.parse({ ...current, minimum_stock: String(current.minimum_stock), model: "" })));
    expect(await getProduct(admin, id)).toMatchObject({ brand: "Northgrid", model: null });

    const both = await updateProduct(admin, id, { ...input({ brand: "x" }), code: current.code, brand: null, model: null });
    expect(both).toMatchObject({ ok: false, fieldErrors: { model: BRAND_OR_MODEL_MESSAGE } });
    expect(await getProduct(admin, id)).toMatchObject({ brand: "Northgrid", model: null });
  });
});
