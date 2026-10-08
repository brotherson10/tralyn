import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { balanceOf, closeDb, createProduct, createUser, insertMovementAsSuperuser, localStack, signIn, type Client, type TestUser } from "./helpers";

let admin: TestUser;
let operator: TestUser;
let operatorClient: Client;

beforeAll(async () => {
  admin = await createUser("admin");
  operator = await createUser("operator");
  operatorClient = await signIn(operator);
});

afterAll(closeDb);

async function stocked(quantity: number) {
  const product = await createProduct();
  // Opening balances only exist through the import path (direct ledger insert).
  await insertMovementAsSuperuser(product.id, "OPENING_BALANCE", quantity, admin.id);
  return product;
}

/** A connection that acts as the operator exactly like PostgREST does (role + JWT claims). */
async function operatorSession(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: localStack().dbUrl });
  await client.connect();
  return client;
}

async function beginAsOperator(client: pg.Client) {
  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query(`select set_config('request.jwt.claims', $1, true)`, [
    JSON.stringify({ sub: operator.id, role: "authenticated" }),
  ]);
}

describe("4. concurrent outputs", () => {
  it("serializes two simultaneous outputs: the second waits for the lock, then fails", async () => {
    const product = await stocked(3);
    const a = await operatorSession();
    const b = await operatorSession();
    try {
      await beginAsOperator(a);
      await beginAsOperator(b);

      // A takes the whole stock but has not committed yet.
      await a.query(`select * from public.register_stock_movement($1, 'OUT', 3)`, [product.id]);

      // B asks for the same units at the same time: it must block on the product lock.
      let settled = false;
      const bResult = b
        .query(`select * from public.register_stock_movement($1, 'OUT', 3)`, [product.id])
        .then(
          () => ({ ok: true as const }),
          (error: Error) => ({ ok: false as const, message: error.message }),
        )
        .finally(() => {
          settled = true;
        });

      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(settled).toBe(false); // still waiting for A

      await a.query("commit");
      const outcome = await bResult;
      expect(outcome).toEqual({ ok: false, message: "INSUFFICIENT_STOCK" });
      await b.query("rollback");
    } finally {
      await a.end();
      await b.end();
    }

    expect((await balanceOf(product.id)).balance).toBe(0);
  });

  it("if the first transaction rolls back, the waiting one succeeds", async () => {
    const product = await stocked(3);
    const a = await operatorSession();
    const b = await operatorSession();
    try {
      await beginAsOperator(a);
      await beginAsOperator(b);
      await a.query(`select * from public.register_stock_movement($1, 'OUT', 3)`, [product.id]);
      const bResult = b.query(`select balance_after from public.register_stock_movement($1, 'OUT', 3)`, [product.id]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await a.query("rollback");
      expect((await bResult).rows[0].balance_after).toBe(0);
      await b.query("commit");
    } finally {
      await a.end();
      await b.end();
    }
    expect((await balanceOf(product.id)).balance).toBe(0);
  });

  it("a burst of 20 parallel API outputs on a stock of 5 yields exactly 5 successes", async () => {
    const product = await stocked(5);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        operatorClient.rpc("register_stock_movement", { p_product_id: product.id, p_type: "OUT", p_quantity: 1 }),
      ),
    );
    const succeeded = results.filter((r) => !r.error);
    const refused = results.filter((r) => r.error?.message === "INSUFFICIENT_STOCK");
    expect(succeeded).toHaveLength(5);
    expect(refused).toHaveLength(15);
    expect(succeeded.map((r) => r.data![0].balance_after).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(await balanceOf(product.id)).toEqual({ balance: 0, status: "OUT_OF_STOCK" });
  });
});
