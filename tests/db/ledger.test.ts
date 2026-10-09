import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  balanceOf,
  categoryId,
  closeDb,
  createProduct,
  createProject,
  createUser,
  db,
  insertMovementAsSuperuser,
  pgError,
  signIn,
  type Client,
  type TestUser,
} from "./helpers";

let admin: TestUser;
let adminClient: Client;
let operatorClient: Client;

beforeAll(async () => {
  admin = await createUser("admin");
  adminClient = await signIn(admin);
  operatorClient = await signIn(await createUser("operator"));
});

afterAll(closeDb);

describe("1. balance derived from the ledger", () => {
  it("computes OPENING + IN + ADJ_IN − OUT − ADJ_OUT", async () => {
    const product = await createProduct();
    // The opening balance comes from the import path; the rest through the RPC.
    await insertMovementAsSuperuser(product.id, "OPENING_BALANCE", 10, admin.id);
    const steps = [
      ["IN", 5],
      ["ADJUSTMENT_IN", 2],
      ["OUT", 4],
      ["ADJUSTMENT_OUT", 3],
    ] as const;
    let last = 0;
    for (const [type, quantity] of steps) {
      const { data, error } = await adminClient.rpc("register_stock_movement", {
        p_product_id: product.id,
        p_type: type,
        p_quantity: quantity,
        p_notes: type.startsWith("ADJUSTMENT") ? "Contagem física" : undefined,
      });
      expect(error).toBeNull();
      last = data![0].balance_after;
    }
    expect(last).toBe(10);
    expect((await balanceOf(product.id)).balance).toBe(10);

    // The same value is visible through the API view (RLS-aware).
    const { data } = await operatorClient.from("product_stock").select("balance").eq("id", product.id).single();
    expect(data?.balance).toBe(10);
  });

  it("a product without movements has balance 0 (no opening balance + one entry → 1)", async () => {
    const product = await createProduct({ minimumStock: 1 });
    expect(await balanceOf(product.id)).toEqual({ balance: 0, status: "OUT_OF_STOCK" });
    await operatorClient.rpc("register_stock_movement", { p_product_id: product.id, p_type: "IN", p_quantity: 1 });
    expect(await balanceOf(product.id)).toEqual({ balance: 1, status: "REORDER" });
  });

  it("the products table has no stock column that could diverge from the ledger", async () => {
    const { rows } = await db().query(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'products' and column_name ~ 'stock|balance|quantity'`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(["minimum_stock"]);
  });
});

describe("2. minimum stock and status", () => {
  it("OUT_OF_STOCK at 0, REORDER up to the minimum, OK above it", async () => {
    const product = await createProduct({ minimumStock: 3 });
    const move = (type: "IN" | "OUT", q: number) =>
      adminClient.rpc("register_stock_movement", { p_product_id: product.id, p_type: type, p_quantity: q });

    expect((await balanceOf(product.id)).status).toBe("OUT_OF_STOCK");
    await move("IN", 3);
    expect(await balanceOf(product.id)).toEqual({ balance: 3, status: "REORDER" });
    await move("IN", 1);
    expect(await balanceOf(product.id)).toEqual({ balance: 4, status: "OK" });
    await move("OUT", 4);
    expect(await balanceOf(product.id)).toEqual({ balance: 0, status: "OUT_OF_STOCK" });
  });

  it("rejects a negative minimum stock", async () => {
    const category = await categoryId();
    const error = await pgError(() =>
      db().query(`insert into public.products (code, category_id, model, minimum_stock) values ($1, $2, 'x', -1)`, [
        `NEG-${Date.now()}`,
        category,
      ]),
    );
    expect(error.code).toBe("23514");
  });
});

describe("3. outputs larger than the balance", () => {
  it("blocks an OUT above the balance and keeps the balance intact", async () => {
    const product = await createProduct();
    await insertMovementAsSuperuser(product.id, "OPENING_BALANCE", 3, admin.id);

    const { error } = await operatorClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "OUT",
      p_quantity: 4,
    });
    expect(error?.message).toBe("INSUFFICIENT_STOCK");
    expect(error?.hint).toBe("3");
    expect((await balanceOf(product.id)).balance).toBe(3);
  });

  it("blocks an ADJUSTMENT_OUT above the balance", async () => {
    const product = await createProduct();
    await adminClient.rpc("register_stock_movement", { p_product_id: product.id, p_type: "IN", p_quantity: 1 });
    const { error } = await adminClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "ADJUSTMENT_OUT",
      p_quantity: 2,
      p_notes: "Contagem física",
    });
    expect(error?.message).toBe("INSUFFICIENT_STOCK");
  });

  it("also blocks direct inserts that bypass the RPC (import path, even as superuser)", async () => {
    const product = await createProduct();
    const error = await pgError(() => insertMovementAsSuperuser(product.id, "OUT", 1, admin.id));
    expect(error.message).toBe("INSUFFICIENT_STOCK");
  });
});

describe("5. immutability of stock_movements", () => {
  let movementId: string;

  beforeAll(async () => {
    const product = await createProduct();
    const { data } = await adminClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "IN",
      p_quantity: 5,
    });
    movementId = data![0].movement_id;
  });

  it("admins cannot update or delete movements through the API", async () => {
    const update = await adminClient.from("stock_movements").update({ quantity: 50 }).eq("id", movementId);
    expect(update.error?.code).toBe("42501");
    const remove = await adminClient.from("stock_movements").delete().eq("id", movementId);
    expect(remove.error?.code).toBe("42501");
  });

  it("nobody can insert directly into the ledger through the API", async () => {
    const product = await createProduct();
    const { error } = await adminClient
      .from("stock_movements")
      .insert({ product_id: product.id, type: "IN", quantity: 1, user_id: admin.id });
    expect(error?.code).toBe("42501");
  });

  it("even the database superuser cannot UPDATE, DELETE or TRUNCATE the ledger", async () => {
    for (const sql of [
      `update public.stock_movements set quantity = 99 where id = '${movementId}'`,
      `delete from public.stock_movements where id = '${movementId}'`,
      `truncate public.stock_movements`,
    ]) {
      const error = await pgError(() => db().query(sql));
      expect(error.message).toBe("IMMUTABLE_LEDGER");
    }
    const { rows } = await db().query(`select quantity from public.stock_movements where id = $1`, [movementId]);
    expect(rows[0].quantity).toBe(5);
  });
});

describe("9. foreign key integrity", () => {
  it("rejects a product with a non-existent category", async () => {
    const error = await pgError(() =>
      db().query(`insert into public.products (code, category_id, model) values ($1, gen_random_uuid(), 'x')`, [
        `FK-${Date.now()}`,
      ]),
    );
    expect(error.code).toBe("23503");
  });

  it("cannot delete a category or product referenced by history (RESTRICT)", async () => {
    const product = await createProduct();
    await adminClient.rpc("register_stock_movement", { p_product_id: product.id, p_type: "IN", p_quantity: 1 });
    expect((await pgError(() => db().query(`delete from public.products where id = $1`, [product.id]))).code).toBe("23503");
    expect(
      (await pgError(async () => db().query(`delete from public.categories where id = $1`, [await categoryId()]))).code,
    ).toBe("23503");
  });

  it("cannot delete an auth user who has movements", async () => {
    const user = await createUser("operator");
    const client = await signIn(user);
    const product = await createProduct();
    await client.rpc("register_stock_movement", { p_product_id: product.id, p_type: "IN", p_quantity: 1 });
    const error = await pgError(() => db().query(`delete from auth.users where id = $1`, [user.id]));
    expect(error.code).toBe("23503");
  });

  it("RPC reports unknown products and unknown / inactive projects", async () => {
    const product = await createProduct();
    await adminClient.rpc("register_stock_movement", { p_product_id: product.id, p_type: "IN", p_quantity: 5 });

    const unknownProduct = await operatorClient.rpc("register_stock_movement", {
      p_product_id: crypto.randomUUID(),
      p_type: "IN",
      p_quantity: 1,
    });
    expect(unknownProduct.error?.message).toBe("PRODUCT_NOT_FOUND");

    const unknownProject = await operatorClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "OUT",
      p_quantity: 1,
      p_project_id: crypto.randomUUID(),
    });
    expect(unknownProject.error?.message).toBe("PROJECT_NOT_FOUND");

    const closed = await operatorClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "OUT",
      p_quantity: 1,
      p_project_id: await createProject("completed"),
    });
    expect(closed.error?.message).toBe("PROJECT_NOT_ACTIVE");

    const ok = await operatorClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "OUT",
      p_quantity: 1,
      p_project_id: await createProject("active"),
      p_document_reference: "  GR-2026/001  ",
    });
    expect(ok.error).toBeNull();
    const { rows } = await db().query(`select project_id, document_reference from public.stock_movements where id = $1`, [
      ok.data![0].movement_id,
    ]);
    expect(rows[0].project_id).not.toBeNull();
    expect(rows[0].document_reference).toBe("GR-2026/001");
  });
});

describe("10. quantity and movement type constraints", () => {
  it("RPC rejects zero and negative quantities", async () => {
    const product = await createProduct();
    for (const quantity of [0, -3]) {
      const { error } = await operatorClient.rpc("register_stock_movement", {
        p_product_id: product.id,
        p_type: "IN",
        p_quantity: quantity,
      });
      expect(error?.message).toBe("INVALID_QUANTITY");
    }
  });

  it("the table rejects non-positive quantities even for the superuser", async () => {
    const product = await createProduct();
    const error = await pgError(() => insertMovementAsSuperuser(product.id, "IN", 0, admin.id));
    expect(error.code).toBe("23514");
  });

  it("rejects unknown movement types and non-integer quantities", async () => {
    const product = await createProduct();
    const badType = await adminClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      // @ts-expect-error — deliberately invalid type
      p_type: "AJUSTE",
      p_quantity: 1,
    });
    expect(badType.error?.code).toBe("22P02");

    const fractional = await adminClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "IN",
      p_quantity: 1.5,
    });
    expect(fractional.error).not.toBeNull();

    const superuser = await pgError(() => insertMovementAsSuperuser(product.id, "AJUSTE", 1, admin.id));
    expect(superuser.code).toBe("22P02");
  });

  it("allows only one OPENING_BALANCE per product (import path; the RPC refuses the type)", async () => {
    const product = await createProduct();
    await insertMovementAsSuperuser(product.id, "OPENING_BALANCE", 2, admin.id);
    const second = await pgError(() => insertMovementAsSuperuser(product.id, "OPENING_BALANCE", 2, admin.id));
    expect(second.code).toBe("23505");
    const viaRpc = await adminClient.rpc("register_stock_movement", { p_product_id: product.id, p_type: "OPENING_BALANCE", p_quantity: 2 });
    expect(viaRpc.error?.message).toBe("FORBIDDEN");
    expect((await balanceOf(product.id)).balance).toBe(2);
  });

  it("blocks movements on inactive products", async () => {
    const product = await createProduct({ active: false });
    const { error } = await adminClient.rpc("register_stock_movement", {
      p_product_id: product.id,
      p_type: "IN",
      p_quantity: 1,
    });
    expect(error?.message).toBe("PRODUCT_INACTIVE");
  });

  it("rejects duplicate product codes and QR codes", async () => {
    const product = await createProduct();
    const category = await categoryId();
    const duplicateCode = await pgError(() =>
      db().query(`insert into public.products (code, category_id, model) values ($1, $2, 'x')`, [product.code, category]),
    );
    expect(duplicateCode.code).toBe("23505");

    await db().query(`update public.products set qr_code = code where id = $1`, [product.id]);
    const duplicateQr = await pgError(() =>
      db().query(`insert into public.products (code, category_id, model, qr_code) values ($1, $2, 'x', $3)`, [
        `${product.code}-B`,
        category,
        product.code,
      ]),
    );
    expect(duplicateQr.code).toBe("23505");
  });
});
