import { describe, expect, it, vi } from "vitest";
import { dashboardKpis } from "@/lib/dashboard/kpis";
import { getStockSummary, listRecentMovements, STOCK_SUMMARY_PAGE_SIZE, summarizeStock, type StockRow } from "./dashboard";
import { DataLoadError, type DbClient } from "./master-data/shared";

const row = (balance: number, status: string, unit = "un"): StockRow => ({ balance, status, unit });

/** Minimal PostgREST query double: records calls, resolves with the next queued response. */
function fakeClient(responses: { data: unknown; error: unknown; count?: number }[]) {
  const calls: { table: string; ops: [string, unknown[]][] }[] = [];
  const client = {
    from(table: string) {
      const call = { table, ops: [] as [string, unknown[]][] };
      calls.push(call);
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "order", "range", "or", "gte", "lt"]) {
        builder[op] = (...args: unknown[]) => {
          call.ops.push([op, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
        Promise.resolve(responses.shift() ?? { data: [], error: null }).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as DbClient, calls };
}

describe("summarizeStock (statuses taken from product_stock)", () => {
  it("no products → all zero", () => {
    expect(summarizeStock([])).toEqual({ products: 0, totalStock: 0, byStatus: { OUT_OF_STOCK: 0, REORDER: 0, OK: 0 }, units: [] });
  });

  it("sums balances and counts each status as given", () => {
    const summary = summarizeStock([row(5, "OK"), row(1, "REORDER"), row(0, "OUT_OF_STOCK"), row(2, "REORDER")]);
    expect(summary).toEqual({ products: 4, totalStock: 8, byStatus: { OUT_OF_STOCK: 1, REORDER: 2, OK: 1 }, units: ["un"] });
  });

  it("all products without stock → total 0, every product OUT_OF_STOCK", () => {
    expect(summarizeStock([row(0, "OUT_OF_STOCK"), row(0, "OUT_OF_STOCK")])).toMatchObject({
      products: 2,
      totalStock: 0,
      byStatus: { OUT_OF_STOCK: 2, REORDER: 0, OK: 0 },
    });
  });

  it("does not re-derive the status from balance/minimum (the view is the source of truth)", () => {
    // A balance of 0 labelled OK by the view is counted as OK: no recomputation here.
    expect(summarizeStock([row(0, "OK")]).byStatus).toEqual({ OUT_OF_STOCK: 0, REORDER: 0, OK: 1 });
  });

  it("ignores unknown statuses and null balances safely", () => {
    expect(summarizeStock([{ balance: null, status: null, unit: null }, row(3, "WEIRD")])).toMatchObject({
      products: 2,
      totalStock: 3,
      byStatus: { OUT_OF_STOCK: 0, REORDER: 0, OK: 0 },
    });
  });

  it("collects distinct units", () => {
    expect(summarizeStock([row(1, "OK", "un"), row(2, "OK", "m"), row(3, "OK", "un")]).units).toEqual(["m", "un"]);
  });
});

describe("dashboardKpis", () => {
  const summary = summarizeStock([row(5, "OK"), row(1, "REORDER"), row(0, "OUT_OF_STOCK")]);

  it("maps the summary to the four cards, values from data only", () => {
    expect(dashboardKpis(summary).map((k) => [k.key, k.label, k.value, k.unit])).toEqual([
      ["totalStock", "Stock total", 6, "un"],
      ["products", "Produtos", 3, null],
      ["reorder", "Repor stock", 1, null],
      ["outOfStock", "Sem stock", 1, null],
    ]);
  });

  it("highlights REORDER / OUT_OF_STOCK only when non-zero", () => {
    const tones = (s: ReturnType<typeof summarizeStock>) => Object.fromEntries(dashboardKpis(s).map((k) => [k.key, k.tone]));
    expect(tones(summary)).toMatchObject({ reorder: "amber", outOfStock: "red" });
    expect(tones(summarizeStock([row(5, "OK")]))).toMatchObject({ reorder: "neutral", outOfStock: "neutral" });
  });

  it("zero products → zero values, no unit", () => {
    expect(dashboardKpis(summarizeStock([])).map((k) => [k.value, k.unit])).toEqual([
      [0, null],
      [0, null],
      [0, null],
      [0, null],
    ]);
  });

  it("mixed units → total without a unit and an explicit note", () => {
    const total = dashboardKpis(summarizeStock([row(1, "OK", "un"), row(2, "OK", "m")]))[0];
    expect(total.unit).toBeNull();
    expect(total.description).toMatch(/unidades diferentes/);
  });

  it("cards link to the products behind each number", () => {
    expect(dashboardKpis(summary).map((k) => k.href)).toEqual([
      "/produtos?estado=ativos",
      "/produtos?estado=ativos",
      "/produtos?estado=ativos&stock=REORDER",
      "/produtos?estado=ativos&stock=OUT_OF_STOCK",
    ]);
  });
});

describe("getStockSummary", () => {
  it("reads only active products from product_stock", async () => {
    const { client, calls } = fakeClient([{ data: [row(4, "OK"), row(1, "REORDER")], error: null }]);
    expect(await getStockSummary(client)).toMatchObject({ products: 2, totalStock: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("product_stock");
    expect(calls[0].ops).toContainEqual(["eq", ["active", true]]);
    expect(calls[0].ops).toContainEqual(["range", [0, STOCK_SUMMARY_PAGE_SIZE - 1]]);
  });

  it("pages past the 1000-row limit instead of silently truncating", async () => {
    const full = Array.from({ length: STOCK_SUMMARY_PAGE_SIZE }, () => row(1, "OK"));
    const { client, calls } = fakeClient([
      { data: full, error: null },
      { data: [row(2, "REORDER")], error: null },
    ]);
    expect(await getStockSummary(client)).toMatchObject({ products: STOCK_SUMMARY_PAGE_SIZE + 1, totalStock: STOCK_SUMMARY_PAGE_SIZE + 2 });
    expect(calls.map((c) => c.ops.find(([op]) => op === "range")?.[1])).toEqual([
      [0, STOCK_SUMMARY_PAGE_SIZE - 1],
      [STOCK_SUMMARY_PAGE_SIZE, 2 * STOCK_SUMMARY_PAGE_SIZE - 1],
    ]);
  });

  it("query error → DataLoadError (handled by the route error boundary)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = fakeClient([{ data: null, error: { code: "42501", message: "permission denied" } }]);
    await expect(getStockSummary(client)).rejects.toBeInstanceOf(DataLoadError);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("indicadores"), { code: "42501" });
    spy.mockRestore();
  });
});

describe("listRecentMovements", () => {
  it("uses the /movimentacoes query: newest first, first page of the given size", async () => {
    const rows = [{ id: "m1" }, { id: "m2" }];
    const { client, calls } = fakeClient([{ data: rows, error: null, count: 15 }]);
    expect(await listRecentMovements(client)).toEqual(rows);
    expect(calls[0].table).toBe("stock_movements");
    expect(calls[0].ops).toContainEqual(["order", ["created_at", { ascending: false }]]);
    expect(calls[0].ops).toContainEqual(["range", [0, 4]]);
  });

  it("empty ledger → empty list", async () => {
    const { client } = fakeClient([{ data: [], error: null, count: 0 }]);
    expect(await listRecentMovements(client)).toEqual([]);
  });

  it("query error → DataLoadError", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { client } = fakeClient([{ data: null, error: { code: "500", message: "boom" } }]);
    await expect(listRecentMovements(client)).rejects.toBeInstanceOf(DataLoadError);
    spy.mockRestore();
  });
});
