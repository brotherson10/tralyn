import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getStockSummary, listRecentMovements } from "@/services/dashboard";
import { DataLoadError } from "@/services/master-data/shared";
import { anonClient, closeDb, createProduct, createUser, db, insertMovementAsSuperuser, signIn, type Client } from "./helpers";

/**
 * Dashboard read model against the LOCAL stack, through the Data API as a
 * signed-in viewer (RLS in effect). The numbers must equal a direct SQL
 * aggregation over the view product_stock (no re-derivation in the app).
 */

let viewer: Client;

beforeAll(async () => {
  const user = await createUser("viewer");
  // Make sure every status and an inactive product exist in the shared test DB.
  const reorder = await createProduct({ minimumStock: 5 });
  await insertMovementAsSuperuser(reorder.id, "OPENING_BALANCE", 3, user.id);
  const ok = await createProduct({ minimumStock: 1 });
  await insertMovementAsSuperuser(ok.id, "OPENING_BALANCE", 4, user.id);
  await createProduct({ minimumStock: 1 }); // OUT_OF_STOCK (no movements)
  const inactive = await createProduct({ minimumStock: 0, active: false });
  await insertMovementAsSuperuser(inactive.id, "OPENING_BALANCE", 7, user.id);
  viewer = await signIn(user);
});

afterAll(closeDb);

describe("dashboard read model (RLS, signed-in viewer)", () => {
  it("summary equals the SQL aggregation of active products in product_stock", async () => {
    const summary = await getStockSummary(viewer);
    const { rows } = await db().query<{ products: number; total: number; oos: number; reorder: number; ok: number }>(
      `select count(*)::int as products, coalesce(sum(balance), 0)::int as total,
              count(*) filter (where status = 'OUT_OF_STOCK')::int as oos,
              count(*) filter (where status = 'REORDER')::int as reorder,
              count(*) filter (where status = 'OK')::int as ok
         from public.product_stock where active`,
    );
    expect(summary).toMatchObject({
      products: rows[0].products,
      totalStock: rows[0].total,
      byStatus: { OUT_OF_STOCK: rows[0].oos, REORDER: rows[0].reorder, OK: rows[0].ok },
    });
    expect(summary.byStatus.OUT_OF_STOCK + summary.byStatus.REORDER + summary.byStatus.OK).toBe(summary.products);
  });

  it("recent movements are the 5 newest ledger rows, with product and responsible", async () => {
    const recent = await listRecentMovements(viewer);
    const { rows } = await db().query<{ id: string }>(`select id from public.stock_movements order by created_at desc, id desc limit 5`);
    expect(recent.map((m) => m.id)).toEqual(rows.map((r) => r.id));
    for (const m of recent) {
      expect(m.product.code).toEqual(expect.any(String));
      expect(m).toHaveProperty("user");
    }
  });

  it("anonymous requests are refused (no grant on product_stock) → load error, no data", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(getStockSummary(anonClient())).rejects.toBeInstanceOf(DataLoadError);
    spy.mockRestore();
  });
});
