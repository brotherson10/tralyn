import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  categoryId,
  closeDb,
  createProduct,
  createUser,
  db,
  insertMovementAsSuperuser,
  pgError,
  setProfile,
  signIn,
  uid,
  type Client,
  type TestUser,
} from "./helpers";

let admin: TestUser;
let operator: TestUser;
let viewer: TestUser;
let adminClient: Client;
let operatorClient: Client;
let viewerClient: Client;
let product: { id: string; code: string };

beforeAll(async () => {
  [admin, operator, viewer] = await Promise.all([createUser("admin"), createUser("operator"), createUser("viewer")]);
  [adminClient, operatorClient, viewerClient] = await Promise.all([signIn(admin), signIn(operator), signIn(viewer)]);
  product = await createProduct();
  // Opening balances only exist through the import path (direct ledger insert).
  await insertMovementAsSuperuser(product.id, "OPENING_BALANCE", 10, admin.id);
});

afterAll(closeDb);

const move = (client: Client, type: "OPENING_BALANCE" | "IN" | "OUT" | "ADJUSTMENT_IN" | "ADJUSTMENT_OUT") =>
  client.rpc("register_stock_movement", {
    p_product_id: product.id,
    p_type: type,
    p_quantity: 1,
    ...(type.startsWith("ADJUSTMENT") ? { p_notes: "Contagem física" } : {}),
  });

describe("6a. viewer — read only", () => {
  it("reads products, stock and movements", async () => {
    const products = await viewerClient.from("product_stock").select("id, balance").eq("id", product.id);
    expect(products.data).toEqual([{ id: product.id, balance: 10 }]);
    const movements = await viewerClient.from("stock_movements").select("id").eq("product_id", product.id);
    expect(movements.data?.length).toBe(1);
  });

  it("cannot register any movement type", async () => {
    for (const type of ["IN", "OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "OPENING_BALANCE"] as const) {
      const { error } = await move(viewerClient, type);
      expect(error?.message, type).toBe("FORBIDDEN");
    }
  });

  it("cannot create or edit master data", async () => {
    const insert = await viewerClient
      .from("products")
      .insert({ code: `V-${uid()}`, category_id: await categoryId(), model: "x" });
    expect(insert.error?.code).toBe("42501");

    const update = await viewerClient.from("products").update({ model: "hacked" }).eq("id", product.id).select();
    expect(update.data ?? []).toEqual([]);
    const { rows } = await db().query(`select model from public.products where id = $1`, [product.id]);
    expect(rows[0].model).toBe("Produto de teste");
  });
});

describe("6b. operator — IN/OUT only, no administration", () => {
  it("registers IN and OUT; the responsible user comes from the session", async () => {
    const entry = await move(operatorClient, "IN");
    expect(entry.error).toBeNull();
    const out = await move(operatorClient, "OUT");
    expect(out.error).toBeNull();

    const { rows } = await db().query(`select user_id from public.stock_movements where id = $1`, [out.data![0].movement_id]);
    expect(rows[0].user_id).toBe(operator.id);
  });

  it("cannot choose the responsible user or the timestamp (no such RPC parameters)", async () => {
    const spoofed = { p_product_id: product.id, p_type: "IN" as const, p_quantity: 1, p_user_id: admin.id };
    const { error } = await operatorClient.rpc("register_stock_movement", spoofed);
    expect(error?.code).toBe("PGRST202"); // function signature not found
  });

  it("cannot register adjustments or opening balances", async () => {
    for (const type of ["ADJUSTMENT_IN", "ADJUSTMENT_OUT", "OPENING_BALANCE"] as const) {
      const { error } = await move(operatorClient, type);
      expect(error?.message, type).toBe("FORBIDDEN");
    }
  });

  it("cannot manage products, categories or profiles (no self-promotion)", async () => {
    const insert = await operatorClient.from("categories").insert({ name: `Cat ${uid()}`, prefix: "ZZ" });
    expect(insert.error?.code).toBe("42501");

    await operatorClient.from("profiles").update({ role: "admin" }).eq("id", operator.id);
    const { rows } = await db().query(`select role from public.profiles where id = $1`, [operator.id]);
    expect(rows[0].role).toBe("operator");
  });
});

describe("6c. admin — administration", () => {
  it("creates and updates master data and products", async () => {
    const prefix = `T${uid().replace(/[^A-Z0-9]/g, "").slice(0, 6)}`;
    const category = await adminClient
      .from("categories")
      .insert({ name: `Categoria ${prefix}`, prefix })
      .select("id")
      .single();
    expect(category.error).toBeNull();

    const created = await adminClient
      .from("products")
      .insert({ code: `A-${uid()}`, category_id: category.data!.id, model: "Novo", minimum_stock: 2 })
      .select("id")
      .single();
    expect(created.error).toBeNull();

    const updated = await adminClient
      .from("products")
      .update({ active: false })
      .eq("id", created.data!.id)
      .select("active")
      .single();
    expect(updated.data?.active).toBe(false);
  });

  it("registers adjustments", async () => {
    expect((await move(adminClient, "ADJUSTMENT_IN")).error).toBeNull();
    expect((await move(adminClient, "ADJUSTMENT_OUT")).error).toBeNull();
  });

  it("cannot register OPENING_BALANCE, even for a product without one (technical import only)", async () => {
    const fresh = await createProduct();
    const { error } = await adminClient.rpc("register_stock_movement", { p_product_id: fresh.id, p_type: "OPENING_BALANCE", p_quantity: 5 });
    expect(error?.message).toBe("FORBIDDEN");
    const { rows } = await db().query(`select count(*)::int as n from public.stock_movements where product_id = $1`, [fresh.id]);
    expect(rows[0].n).toBe(0);
  });

  it("changes roles of other users", async () => {
    const target = await createUser("viewer");
    const { error } = await adminClient.from("profiles").update({ role: "operator" }).eq("id", target.id);
    expect(error).toBeNull();
    const { rows } = await db().query(`select role from public.profiles where id = $1`, [target.id]);
    expect(rows[0].role).toBe("operator");
  });

  it("cannot hard-delete anything (soft delete only)", async () => {
    const { error } = await adminClient.from("products").delete().eq("id", product.id);
    expect(error?.code).toBe("42501");
  });

  it("the last active admin cannot be demoted or deactivated", async () => {
    const client = await db().connect();
    try {
      await client.query("begin");
      const error = await pgError(() =>
        client.query(`update public.profiles set active = false where role = 'admin' and active`),
      );
      expect(error.message).toBe("LAST_ADMIN");
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("new auth users start as viewer", async () => {
    const id = crypto.randomUUID();
    // Rolled back: this minimal row is only for the trigger check and is not a
    // complete Auth user (GoTrue cannot list rows with NULL token columns).
    const client = await db().connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, '{}')`,
        [id, `novo-${id.slice(0, 8)}@test.local`],
      );
      const { rows } = await client.query(`select role, name, active from public.profiles where id = $1`, [id]);
      expect(rows[0]).toEqual({ role: "viewer", name: `novo-${id.slice(0, 8)}`, active: true });
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("7. inactive user", () => {
  let inactive: TestUser;
  let client: Client;

  beforeAll(async () => {
    inactive = await createUser("admin");
    client = await signIn(inactive);
    await setProfile(inactive.id, { active: false });
  });

  it("sees no business data, only their own profile", async () => {
    expect((await client.from("products").select("id")).data).toEqual([]);
    expect((await client.from("stock_movements").select("id")).data).toEqual([]);
    expect((await client.from("product_stock").select("id")).data).toEqual([]);
    const profiles = await client.from("profiles").select("id, active");
    expect(profiles.data).toEqual([{ id: inactive.id, active: false }]);
  });

  it("cannot register movements or administer, even with the admin role", async () => {
    for (const type of ["IN", "OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT", "OPENING_BALANCE"] as const) {
      expect((await move(client, type)).error?.message, type).toBe("FORBIDDEN");
    }
    const update = await client.from("products").update({ model: "x" }).eq("id", product.id).select();
    expect(update.data ?? []).toEqual([]);
  });
});

describe("8. anonymous access", () => {
  const anon = anonClient();

  it("cannot read any table or view", async () => {
    for (const table of ["products", "categories", "locations", "suppliers", "projects", "profiles", "stock_movements", "product_stock"] as const) {
      const { data, error } = await anon.from(table as "products").select("*").limit(1);
      expect(error?.code, table).toBe("42501");
      expect(data).toBeNull();
    }
  });

  it("cannot call the movement RPC", async () => {
    const { error } = await anon.rpc("register_stock_movement", { p_product_id: product.id, p_type: "IN", p_quantity: 1 });
    expect(error).not.toBeNull();
  });

  it("cannot reach private helper functions", async () => {
    const { error } = await (anon as unknown as Client).schema("private" as "public").rpc("is_admin" as never);
    expect(error).not.toBeNull();
  });
});
