import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMovement, listMovements, loadMovementFormOptions, registerMovement } from "@/services/movements";
import { getProduct, getProductStock } from "@/services/products";
import { movementSchema, type MovementInput } from "@/validation/movements";
import { closeDb, createProduct, createProject, createUser, db, setProfile, signIn, uid, type Client, type TestUser } from "./helpers";

/**
 * Stock movements through the application service → RPC, with real sessions.
 * Balances are only ever changed by register_stock_movement.
 */

let adminUser: TestUser;
let operatorUser: TestUser;
let admin: Client;
let operator: Client;
let viewer: Client;
let inactive: Client;

beforeAll(async () => {
  [adminUser, operatorUser] = await Promise.all([createUser("admin"), createUser("operator")]);
  [admin, operator, viewer] = await Promise.all([signIn(adminUser), signIn(operatorUser), createUser("viewer").then(signIn)]);
  const inactiveUser = await createUser("admin");
  inactive = await signIn(inactiveUser);
  await setProfile(inactiveUser.id, { active: false });
});

afterAll(closeDb);

const input = (productId: string, type: string, quantity: number, extra: Record<string, string> = {}): MovementInput =>
  movementSchema.parse({ product_id: productId, type, quantity: String(quantity), ...extra });

async function register(client: Client, productId: string, type: string, quantity: number, extra: Record<string, string> = {}) {
  return registerMovement(client, input(productId, type, quantity, extra));
}

async function balance(productId: string) {
  return (await getProductStock(admin, productId))!;
}

const adjustmentNote = { notes: "Contagem física de teste." };

describe("registering movements by role", () => {
  it("admin registers IN, OUT, ADJUSTMENT_IN and ADJUSTMENT_OUT", async () => {
    const product = await createProduct();
    expect(await register(admin, product.id, "IN", 10)).toMatchObject({ ok: true, balanceAfter: 10 });
    expect(await register(admin, product.id, "OUT", 3)).toMatchObject({ ok: true, balanceAfter: 7 });
    expect(await register(admin, product.id, "ADJUSTMENT_IN", 2, adjustmentNote)).toMatchObject({ ok: true, balanceAfter: 9 });
    expect(await register(admin, product.id, "ADJUSTMENT_OUT", 1, adjustmentNote)).toMatchObject({ ok: true, balanceAfter: 8 });
    expect((await balance(product.id)).balance).toBe(8);
  });

  it("operator registers IN and OUT but not adjustments", async () => {
    const product = await createProduct();
    expect(await register(operator, product.id, "IN", 5)).toMatchObject({ ok: true, balanceAfter: 5 });
    expect(await register(operator, product.id, "OUT", 2)).toMatchObject({ ok: true, balanceAfter: 3 });
    for (const type of ["ADJUSTMENT_IN", "ADJUSTMENT_OUT"]) {
      const result = await register(operator, product.id, type, 1, adjustmentNote);
      expect(result).toMatchObject({ ok: false, message: "O seu perfil não permite registar este tipo de movimentação." });
    }
    expect((await balance(product.id)).balance).toBe(3);
  });

  it("viewer and inactive users cannot register anything", async () => {
    const product = await createProduct();
    for (const client of [viewer, inactive]) {
      for (const type of ["IN", "OUT"]) {
        expect((await register(client, product.id, type, 1)).ok).toBe(false);
      }
    }
    const { rows } = await db().query(`select count(*)::int as n from public.stock_movements where product_id = $1`, [product.id]);
    expect(rows[0].n).toBe(0);
  });

  it("the RPC itself refuses adjustments without notes (NULL, empty or blank)", async () => {
    const product = await createProduct();
    await register(admin, product.id, "IN", 10);
    for (const type of ["ADJUSTMENT_IN", "ADJUSTMENT_OUT"] as const) {
      for (const notes of [undefined, null, "", "   \n\t "]) {
        const { data, error } = await admin.rpc("register_stock_movement", {
          p_product_id: product.id,
          p_type: type,
          p_quantity: 1,
          ...(notes === undefined ? {} : { p_notes: notes as string }),
        });
        expect(error?.message, `${type} ${JSON.stringify(notes)}`).toBe("ADJUSTMENT_NOTES_REQUIRED");
        expect(data).toBeNull();
      }
    }
    const { rows } = await db().query(`select count(*)::int as n from public.stock_movements where product_id = $1`, [product.id]);
    expect(rows[0].n).toBe(1);
    expect((await balance(product.id)).balance).toBe(10);
  });

  it("the RPC accepts adjustments with notes and stores them trimmed; IN/OUT need none", async () => {
    const product = await createProduct();
    const call = (type: string, notes?: string) =>
      admin.rpc("register_stock_movement", { p_product_id: product.id, p_type: type as "IN", p_quantity: 1, ...(notes ? { p_notes: notes } : {}) });
    expect((await call("IN")).error).toBeNull();
    const adjusted = await call("ADJUSTMENT_IN", "  Contagem física  ");
    expect(adjusted.error).toBeNull();
    expect((await call("ADJUSTMENT_OUT", "Danos")).error).toBeNull();
    expect((await call("OUT")).error).toBeNull();
    const { rows } = await db().query(`select notes from public.stock_movements where id = $1`, [adjusted.data![0].movement_id]);
    expect(rows[0].notes).toBe("Contagem física");
    expect((await balance(product.id)).balance).toBe(0);
  });

  it("authorization still comes first: operator/viewer get FORBIDDEN for adjustments without notes", async () => {
    const product = await createProduct();
    for (const client of [operator, viewer]) {
      for (const type of ["ADJUSTMENT_IN", "ADJUSTMENT_OUT"] as const) {
        const { error } = await client.rpc("register_stock_movement", { p_product_id: product.id, p_type: type, p_quantity: 1 });
        expect(error?.message).toBe("FORBIDDEN");
      }
    }
  });

  it("the service maps ADJUSTMENT_NOTES_REQUIRED to the notes field", async () => {
    const product = await createProduct();
    await register(admin, product.id, "IN", 1);
    // Bypass the form schema (which already requires notes) to reach the RPC check.
    const result = await registerMovement(admin, { ...input(product.id, "IN", 1), type: "ADJUSTMENT_IN", notes: null });
    expect(result).toMatchObject({ ok: false, fieldErrors: { notes: expect.any(String) } });
  });

  it("OPENING_BALANCE is not offered by the operational form (only the import uses it)", async () => {
    expect(movementSchema.safeParse({ product_id: crypto.randomUUID(), type: "OPENING_BALANCE", quantity: "1" }).success).toBe(false);
  });
});

describe("database rules surface as friendly errors", () => {
  it("refuses zero and negative quantities even if form validation is bypassed", async () => {
    const product = await createProduct();
    for (const quantity of [0, -5]) {
      const result = await registerMovement(operator, { ...input(product.id, "IN", 1), quantity });
      expect(result).toMatchObject({ ok: false, fieldErrors: { quantity: "A quantidade tem de ser um número inteiro maior que zero." } });
    }
  });

  it("refuses an output above the balance and reports what is available; the balance never goes negative", async () => {
    const product = await createProduct();
    await register(admin, product.id, "IN", 10);
    await register(admin, product.id, "OUT", 3);
    const result = await register(operator, product.id, "OUT", 8);
    expect(result).toEqual({
      ok: false,
      message: "Stock insuficiente. Disponível: 7 un.",
      fieldErrors: { quantity: "Stock insuficiente. Disponível: 7 un." },
    });
    const adjustment = await register(admin, product.id, "ADJUSTMENT_OUT", 8, adjustmentNote);
    expect(adjustment).toMatchObject({ ok: false, message: "Stock insuficiente. Disponível: 7 un." });
    expect((await balance(product.id)).balance).toBe(7);
  });

  it("refuses inactive products", async () => {
    const product = await createProduct({ active: false });
    expect(await register(admin, product.id, "IN", 1)).toMatchObject({
      ok: false,
      message: "Este produto está inativo e não pode receber movimentações.",
    });
  });

  it("refuses completed and cancelled projects, accepts active ones", async () => {
    const product = await createProduct();
    await register(admin, product.id, "IN", 5);
    for (const status of ["completed", "cancelled"] as const) {
      const result = await register(operator, product.id, "OUT", 1, { project_id: await createProject(status) });
      expect(result).toMatchObject({ ok: false, fieldErrors: { project_id: expect.stringMatching(/concluído ou cancelado/) } });
    }
    const projectId = await createProject("active");
    const ok = await register(operator, product.id, "OUT", 1, { project_id: projectId, document_reference: "GR-001" });
    expect(ok.ok).toBe(true);
    const movement = await getMovement(viewer, ok.ok ? ok.movementId : "");
    expect(movement).toMatchObject({ project: { id: projectId }, document_reference: "GR-001" });
  });

  it("refuses unknown products and projects", async () => {
    const product = await createProduct();
    expect(await register(admin, crypto.randomUUID(), "IN", 1)).toMatchObject({ ok: false, message: "O produto escolhido não existe." });
    expect(await register(admin, product.id, "IN", 1, { project_id: crypto.randomUUID() })).toMatchObject({
      ok: false,
      message: "O projeto escolhido não existe.",
    });
  });
});

describe("audit and ledger integrity", () => {
  it("records the authenticated user and a database timestamp", async () => {
    const product = await createProduct();
    const before = Date.now();
    const result = await register(operator, product.id, "IN", 4);
    if (!result.ok) throw new Error(result.message);

    const { rows } = await db().query(`select user_id, created_at from public.stock_movements where id = $1`, [result.movementId]);
    expect(rows[0].user_id).toBe(operatorUser.id);
    const created = new Date(rows[0].created_at).getTime();
    expect(Math.abs(created - before)).toBeLessThan(60_000);
    expect((await getMovement(admin, result.movementId))?.user?.name).toBe("Teste operator");
  });

  it("movements cannot be edited or deleted", async () => {
    const product = await createProduct();
    const result = await register(admin, product.id, "IN", 2);
    if (!result.ok) throw new Error(result.message);
    const update = await admin.from("stock_movements").update({ quantity: 20 }).eq("id", result.movementId);
    const remove = await admin.from("stock_movements").delete().eq("id", result.movementId);
    expect(update.error?.code).toBe("42501");
    expect(remove.error?.code).toBe("42501");
    expect((await getMovement(admin, result.movementId))?.quantity).toBe(2);
  });

  it("registering a movement updates product_stock but never writes to products", async () => {
    const product = await createProduct();
    const before = (await getProduct(admin, product.id))!;
    await register(admin, product.id, "IN", 6);
    const after = (await getProduct(admin, product.id))!;
    expect(after).toEqual(before); // same row, same updated_at
    expect((await balance(product.id)).balance).toBe(6);
  });

  it("status follows the ledger: Sem stock → OK → Repor stock → Sem stock (minimum 2)", async () => {
    const product = await createProduct({ minimumStock: 2 });
    expect(await balance(product.id)).toMatchObject({ balance: 0, status: "OUT_OF_STOCK" });
    await register(admin, product.id, "IN", 10);
    expect(await balance(product.id)).toMatchObject({ balance: 10, status: "OK" });
    await register(operator, product.id, "OUT", 8);
    expect(await balance(product.id)).toMatchObject({ balance: 2, status: "REORDER" });
    await register(operator, product.id, "OUT", 2);
    expect(await balance(product.id)).toMatchObject({ balance: 0, status: "OUT_OF_STOCK" });
  });

  it("concurrent outputs through the service can never overdraw the stock", async () => {
    const product = await createProduct();
    await register(admin, product.id, "IN", 5);
    const results = await Promise.all(Array.from({ length: 15 }, () => register(operator, product.id, "OUT", 1)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.message.startsWith("Stock insuficiente"))).toBe(true);
    expect((await balance(product.id)).balance).toBe(0);
  });
});

describe("history", () => {
  it("lists newest first with product, project and user embedded, and filters on the server", async () => {
    const marker = uid();
    const productA = await createProduct();
    const productB = await createProduct();
    const projectId = await createProject("active");
    await db().query(`update public.products set model = $2 where id = $1`, [productA.id, `Historico ${marker}`]);

    const r1 = await register(admin, productA.id, "IN", 10);
    const r2 = await register(operator, productA.id, "OUT", 3, { project_id: projectId });
    const r3 = await register(admin, productA.id, "ADJUSTMENT_IN", 1, adjustmentNote);
    await register(admin, productB.id, "IN", 1);
    const ids = [r1, r2, r3].map((r) => (r.ok ? r.movementId : ""));

    const all = await listMovements(viewer, { productId: productA.id });
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => r.id)).toEqual([...ids].reverse());
    expect(all.rows[1]).toMatchObject({
      type: "OUT",
      quantity: 3,
      product: { id: productA.id, code: productA.code },
      project: { id: projectId },
      user: { name: "Teste operator" },
    });

    expect((await listMovements(viewer, { q: marker })).rows.map((r) => r.product.id)).toEqual([productA.id, productA.id, productA.id]);
    expect((await listMovements(viewer, { q: productA.code, type: "OUT" })).rows.map((r) => r.id)).toEqual([ids[1]]);
    expect((await listMovements(viewer, { projectId })).rows.map((r) => r.id)).toEqual([ids[1]]);

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Lisbon" }).format(new Date());
    expect((await listMovements(viewer, { productId: productA.id, from: today, to: today })).total).toBeGreaterThanOrEqual(3);
    expect((await listMovements(viewer, { productId: productA.id, from: "2000-01-01", to: "2000-01-02" })).total).toBe(0);
  });

  it("paginates on the server", async () => {
    const product = await createProduct();
    for (let i = 0; i < 5; i += 1) await register(admin, product.id, "IN", 1);
    const first = await listMovements(viewer, { productId: product.id, page: 1 }, 2);
    const third = await listMovements(viewer, { productId: product.id, page: 3 }, 2);
    expect(first).toMatchObject({ total: 5, rows: expect.any(Array) });
    expect(first.rows).toHaveLength(2);
    expect(third.rows).toHaveLength(1);
    expect((await listMovements(viewer, { productId: product.id, page: 9 }, 2)).outOfRange).toBe(true);
  });

  it("the inactive user cannot read the history", async () => {
    expect((await listMovements(inactive, {})).rows).toEqual([]);
  });

  it("the form only offers active products and active projects", async () => {
    const activeProduct = await createProduct();
    const inactiveProduct = await createProduct({ active: false });
    const activeProject = await createProject("active");
    const closedProject = await createProject("completed");
    const byCode = async (code: string) =>
      (await loadMovementFormOptions(operator, { search: code })).products.map((p) => p.id);
    expect(await byCode(activeProduct.code)).toContain(activeProduct.id);
    expect(await byCode(inactiveProduct.code)).not.toContain(inactiveProduct.id);
    // A preselected inactive product is never added either.
    const preselected = await loadMovementFormOptions(operator, { includeProductId: inactiveProduct.id });
    expect(preselected.products.map((p) => p.id)).not.toContain(inactiveProduct.id);

    const options = await loadMovementFormOptions(operator, { includeProductId: activeProduct.id });
    expect(options.products.length).toBeLessThanOrEqual(101);
    const productIds = options.products.map((p) => p.id);
    const projectIds = options.projects.map((p) => p.id);
    expect(productIds).toContain(activeProduct.id);
    expect(productIds).not.toContain(inactiveProduct.id);
    expect(projectIds).toContain(activeProject);
    expect(projectIds).not.toContain(closedProject);
  });
});
