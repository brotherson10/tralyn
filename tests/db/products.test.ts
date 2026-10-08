import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK_FIELDS_ERROR, FORBIDDEN_ERROR, NOT_FOUND_OR_FORBIDDEN_ERROR } from "@/lib/db/errors";
import { createCategory, setCategoryActive } from "@/services/master-data/categories";
import { createLocation, setLocationActive } from "@/services/master-data/locations";
import type { MutationResult } from "@/services/master-data/shared";
import { createSupplier, setSupplierActive } from "@/services/master-data/suppliers";
import {
  createProduct,
  getProduct,
  getProductStock,
  listProducts,
  loadProductFormOptions,
  setProductActive,
  updateProduct,
} from "@/services/products";
import { categorySchema, locationSchema, supplierSchema } from "@/validation/master-data";
import { productSchema, type ProductInput } from "@/validation/products";
import { closeDb, createUser, db, setProfile, signIn, uid, type Client } from "./helpers";

/**
 * Products through the real services and real sessions (RLS in effect).
 * Stock statuses are produced with register_stock_movement (the ledger API);
 * balances are never written directly.
 */

let admin: Client;
let operator: Client;
let viewer: Client;
let inactive: Client;
let prefix: string;
let categoryId: string;
let locationId: string;
let supplierId: string;

function ok(result: MutationResult): string {
  if (!result.ok) throw new Error(`expected success: ${result.message} ${JSON.stringify(result.fieldErrors)}`);
  return result.id;
}

let sequence = 0;
function product(overrides: Partial<Record<string, string>> = {}): ProductInput {
  sequence += 1;
  return productSchema.parse({
    code: `${prefix}-${String(sequence).padStart(3, "0")}`,
    category_id: categoryId,
    brand: "Marca Teste",
    model: `Modelo ${uid()}`,
    unit: "un",
    minimum_stock: "2",
    location_id: locationId,
    default_supplier_id: supplierId,
    ...overrides,
  });
}

async function movementCount(productId: string): Promise<number> {
  const { rows } = await db().query(`select count(*)::int as n from public.stock_movements where product_id = $1`, [productId]);
  return rows[0].n;
}

async function move(productId: string, type: "IN" | "OUT", quantity: number) {
  const { error } = await admin.rpc("register_stock_movement", { p_product_id: productId, p_type: type, p_quantity: quantity });
  if (error) throw new Error(error.message);
}

beforeAll(async () => {
  [admin, operator, viewer] = await Promise.all([
    createUser("admin").then(signIn),
    createUser("operator").then(signIn),
    createUser("viewer").then(signIn),
  ]);
  const inactiveUser = await createUser("admin");
  inactive = await signIn(inactiveUser);
  await setProfile(inactiveUser.id, { active: false });

  prefix = `P${uid().replace(/[^A-Z0-9]/g, "").slice(0, 6)}`;
  categoryId = ok(await createCategory(admin, categorySchema.parse({ name: `Produtos ${prefix}`, prefix })));
  locationId = ok(await createLocation(admin, locationSchema.parse({ code: `LOC-${prefix}` })));
  supplierId = ok(await createSupplier(admin, supplierSchema.parse({ name: `Fornecedor ${prefix}` })));
});

afterAll(closeDb);

describe("create", () => {
  it("admin creates a product that starts with balance 0 and no stock movements", async () => {
    const input = product();
    const id = ok(await createProduct(admin, input));

    const stock = await getProductStock(viewer, id);
    expect(stock).toMatchObject({ code: input.code, balance: 0, status: "OUT_OF_STOCK", last_movement_at: null });
    expect(await movementCount(id)).toBe(0);
  });

  it("rejects a duplicate code (also when typed in lowercase)", async () => {
    const input = product();
    ok(await createProduct(admin, input));
    const duplicate = await createProduct(admin, productSchema.parse({ ...input, code: input.code.toLowerCase(), minimum_stock: "0" }));
    expect(duplicate).toMatchObject({ ok: false, fieldErrors: { code: "Já existe um produto com este código." } });
  });

  it("requires the code to start with the category prefix", async () => {
    const result = await createProduct(admin, product({ code: "ZZZ-001" }));
    expect(result).toMatchObject({ ok: false, fieldErrors: { code: `O código deve começar pelo prefixo da categoria: ${prefix}-` } });
  });

  it("the database rejects a negative minimum stock if validation is bypassed", async () => {
    const result = await createProduct(admin, { ...product(), minimum_stock: -1 });
    expect(result).toMatchObject({ ok: false, fieldErrors: { minimum_stock: "O stock mínimo não pode ser negativo." } });
  });

  it("rejects non-existent relations", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    const result = await createProduct(admin, { ...product(), category_id: missing, location_id: missing, default_supplier_id: missing });
    expect(result).toMatchObject({
      ok: false,
      fieldErrors: {
        category_id: "A categoria escolhida não existe.",
        location_id: "A localização escolhida não existe.",
        default_supplier_id: "O fornecedor escolhido não existe.",
      },
    });
  });

  it("the FK itself also rejects a missing category (defence in depth)", async () => {
    const { error } = await admin
      .from("products")
      .insert({ code: `${prefix}-999`, category_id: "00000000-0000-4000-8000-000000000000", model: "x" });
    expect(error?.code).toBe("23503");
  });

  it("new products cannot use an inactive category, location or supplier", async () => {
    const p2 = `Q${uid().replace(/[^A-Z0-9]/g, "").slice(0, 6)}`;
    const cat = ok(await createCategory(admin, categorySchema.parse({ name: `Inativa ${p2}`, prefix: p2 })));
    const loc = ok(await createLocation(admin, locationSchema.parse({ code: `INA-${p2}` })));
    const sup = ok(await createSupplier(admin, supplierSchema.parse({ name: `Inativo ${p2}` })));
    ok(await setCategoryActive(admin, cat, false));
    ok(await setLocationActive(admin, loc, false));
    ok(await setSupplierActive(admin, sup, false));

    const result = await createProduct(admin, {
      ...product({ code: `${p2}-001` }),
      category_id: cat,
      location_id: loc,
      default_supplier_id: sup,
    });
    expect(result).toEqual({
      ok: false,
      message: CHECK_FIELDS_ERROR,
      fieldErrors: {
        category_id: "Esta categoria está inativa. Escolha uma categoria ativa.",
        location_id: "Esta localização está inativa. Escolha uma localização ativa.",
        default_supplier_id: "Este fornecedor está inativo. Escolha um fornecedor ativo.",
      },
    });

    // The form options for a new product do not even offer them.
    const options = await loadProductFormOptions(admin, null);
    expect(options.categories.map((o) => o.value)).not.toContain(cat);
    expect(options.locations.map((o) => o.value)).not.toContain(loc);
    expect(options.suppliers.map((o) => o.value)).not.toContain(sup);
  });
});

describe("edit and activation", () => {
  it("admin edits a product without touching its stock or movements", async () => {
    const id = ok(await createProduct(admin, product()));
    await move(id, "IN", 5);

    const current = (await getProduct(admin, id))!;
    ok(await updateProduct(admin, id, productSchema.parse({ ...current, minimum_stock: "10", specification: "Nova spec", location_id: "", default_supplier_id: "" })));

    const stock = await getProductStock(admin, id);
    expect(stock).toMatchObject({ balance: 5, minimum_stock: 10, status: "REORDER", specification: "Nova spec", location_id: null });
    expect(await movementCount(id)).toBe(1);
  });

  it("keeps a relation that became inactive, but refuses switching to another inactive one", async () => {
    const p3 = `R${uid().replace(/[^A-Z0-9]/g, "").slice(0, 6)}`;
    const cat = ok(await createCategory(admin, categorySchema.parse({ name: `Cat ${p3}`, prefix: p3 })));
    const loc = ok(await createLocation(admin, locationSchema.parse({ code: `KEEP-${p3}` })));
    const otherInactiveLoc = ok(await createLocation(admin, locationSchema.parse({ code: `OTHER-${p3}` })));
    const id = ok(await createProduct(admin, { ...product({ code: `${p3}-001` }), category_id: cat, location_id: loc }));

    ok(await setCategoryActive(admin, cat, false));
    ok(await setLocationActive(admin, loc, false));
    ok(await setLocationActive(admin, otherInactiveLoc, false));

    // The edit form still offers (and labels) the current inactive relations.
    const current = (await getProduct(admin, id))!;
    const options = await loadProductFormOptions(admin, current);
    expect(options.categories.find((o) => o.value === cat)).toMatchObject({ inactive: true });
    expect(options.locations.find((o) => o.value === loc)).toMatchObject({ inactive: true });
    expect(options.locations.map((o) => o.value)).not.toContain(otherInactiveLoc);

    // Saving other changes keeps them.
    const input = productSchema.parse({ ...current, minimum_stock: "3", model: `${current.model} v2` });
    ok(await updateProduct(admin, id, input));
    expect(await getProduct(admin, id)).toMatchObject({ category_id: cat, location_id: loc, minimum_stock: 3 });

    // Switching to a different inactive location is refused.
    const switched = await updateProduct(admin, id, { ...input, location_id: otherInactiveLoc });
    expect(switched).toMatchObject({ ok: false, fieldErrors: { location_id: "Esta localização está inativa. Escolha uma localização ativa." } });
  });

  it("admin deactivates and reactivates; inactive products refuse new movements; history is kept", async () => {
    const id = ok(await createProduct(admin, product()));
    await move(id, "IN", 4);

    ok(await setProductActive(admin, id, false));
    expect((await getProductStock(viewer, id))?.active).toBe(false);
    const { error } = await admin.rpc("register_stock_movement", { p_product_id: id, p_type: "IN", p_quantity: 1 });
    expect(error?.message).toBe("PRODUCT_INACTIVE");
    expect(await movementCount(id)).toBe(1);
    expect((await getProductStock(viewer, id))?.balance).toBe(4);

    ok(await setProductActive(admin, id, true));
    await move(id, "IN", 1);
    expect((await getProductStock(viewer, id))?.balance).toBe(5);
  });
});

describe("stock status comes from the database (product_stock)", () => {
  it("OUT_OF_STOCK → REORDER → OK → OUT_OF_STOCK", async () => {
    const id = ok(await createProduct(admin, product({ minimum_stock: "3" })));
    expect((await getProductStock(viewer, id))?.status).toBe("OUT_OF_STOCK");
    await move(id, "IN", 3);
    expect(await getProductStock(viewer, id)).toMatchObject({ balance: 3, status: "REORDER" });
    await move(id, "IN", 1);
    expect(await getProductStock(viewer, id)).toMatchObject({ balance: 4, status: "OK" });
    await move(id, "OUT", 4);
    expect(await getProductStock(viewer, id)).toMatchObject({ balance: 0, status: "OUT_OF_STOCK" });
  });
});

describe("search and filters", () => {
  it("combines text search, category, location, state and stock status", async () => {
    const marker = `Pesquisa${uid()}`;
    const withStock = ok(await createProduct(admin, product({ model: `${marker} A`, minimum_stock: "0" })));
    const noLocation = ok(await createProduct(admin, product({ model: `${marker} B`, location_id: "" })));
    const inactiveOne = ok(await createProduct(admin, product({ model: `${marker} C` })));
    await move(withStock, "IN", 2);
    ok(await setProductActive(admin, inactiveOne, false));

    const ids = async (filters: Parameters<typeof listProducts>[1]) =>
      (await listProducts(viewer, { q: marker, ...filters })).map((p) => p.id).sort();

    expect(await ids({})).toEqual([withStock, noLocation, inactiveOne].sort());
    expect(await ids({ categoryId })).toHaveLength(3);
    expect(await ids({ location: "sem" })).toEqual([noLocation]);
    expect(await ids({ location: locationId })).toEqual([withStock, inactiveOne].sort());
    expect(await ids({ active: "inativos" })).toEqual([inactiveOne]);
    expect(await ids({ stock: "OK" })).toEqual([withStock]);
    expect(await ids({ stock: "OUT_OF_STOCK", active: "ativos" })).toEqual([noLocation]);

    const code = (await getProduct(admin, withStock))!.code;
    expect((await listProducts(viewer, { q: code })).map((p) => p.id)).toEqual([withStock]);
  });
});

describe("authorization (RLS is the authority)", () => {
  let id: string;
  beforeAll(async () => {
    id = ok(await createProduct(admin, product()));
  });

  it.each([
    ["operator", () => operator],
    ["viewer", () => viewer],
  ])("%s can read but cannot create, edit or (de)activate", async (_label, client) => {
    expect((await getProductStock(client(), id))?.id).toBe(id);
    expect(await createProduct(client(), product())).toEqual({ ok: false, message: FORBIDDEN_ERROR });

    const current = (await getProduct(client(), id))!;
    const update = await updateProduct(client(), id, productSchema.parse({ ...current, minimum_stock: "99" }));
    expect(update).toEqual({ ok: false, message: NOT_FOUND_OR_FORBIDDEN_ERROR });
    expect(await setProductActive(client(), id, false)).toEqual({ ok: false, message: NOT_FOUND_OR_FORBIDDEN_ERROR });

    expect(await getProduct(admin, id)).toMatchObject({ minimum_stock: 2, active: true });
  });

  it("an inactive user cannot read or change products", async () => {
    expect(await listProducts(inactive, {})).toEqual([]);
    expect((await createProduct(inactive, product())).ok).toBe(false);
    expect(await setProductActive(inactive, id, false)).toEqual({ ok: false, message: NOT_FOUND_OR_FORBIDDEN_ERROR });
    expect((await getProduct(admin, id))?.active).toBe(true);
  });

  it("no role can delete products through the API", async () => {
    for (const client of [admin, operator, viewer]) {
      const { error } = await client.from("products").delete().eq("id", id);
      expect(error?.code).toBe("42501");
    }
    expect(await getProduct(admin, id)).not.toBeNull();
  });

  it("nobody can write stock through the products table", async () => {
    const { error } = await admin.from("products").update({ balance: 100 } as never).eq("id", id);
    expect(error).not.toBeNull();
    expect((await getProductStock(admin, id))?.balance).toBe(0);
  });
});
