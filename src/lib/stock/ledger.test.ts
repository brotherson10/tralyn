import { describe, expect, it } from "vitest";
import { checkMovement, computeBalance, signedQuantity, type LedgerEntry } from "./ledger";
import { stockStatus } from "./status";

describe("computeBalance", () => {
  it("returns 0 for an empty ledger", () => {
    expect(computeBalance([])).toBe(0);
  });

  it("adds opening balance, entries and positive adjustments and subtracts outputs", () => {
    const entries: LedgerEntry[] = [
      { type: "OPENING_BALANCE", quantity: 10 },
      { type: "IN", quantity: 5 },
      { type: "ADJUSTMENT_IN", quantity: 2 },
      { type: "OUT", quantity: 4 },
      { type: "ADJUSTMENT_OUT", quantity: 3 },
    ];
    expect(computeBalance(entries)).toBe(10);
  });

  it("keeps a product with zero opening balance plus one entry at 1 (no opening balance, single entry)", () => {
    expect(computeBalance([{ type: "IN", quantity: 1 }])).toBe(1);
  });

  it("rejects non-positive or fractional quantities in the ledger", () => {
    expect(() => computeBalance([{ type: "IN", quantity: 0 }])).toThrow(RangeError);
    expect(() => computeBalance([{ type: "OUT", quantity: -1 }])).toThrow(RangeError);
    expect(() => signedQuantity("IN", 1.5)).toThrow(RangeError);
  });
});

describe("checkMovement", () => {
  it("allows an output that leaves exactly zero", () => {
    expect(checkMovement(3, "OUT", 3)).toEqual({ ok: true, resultingBalance: 0 });
  });

  it("blocks an output that would leave the balance negative", () => {
    expect(checkMovement(3, "OUT", 4)).toEqual({
      ok: false,
      reason: "INSUFFICIENT_STOCK",
      available: 3,
    });
  });

  it("blocks a negative adjustment beyond the available stock", () => {
    expect(checkMovement(1, "ADJUSTMENT_OUT", 2).ok).toBe(false);
  });

  it("allows inbound movements regardless of the current balance", () => {
    expect(checkMovement(0, "IN", 7)).toEqual({ ok: true, resultingBalance: 7 });
  });

  it("rejects invalid quantities", () => {
    expect(checkMovement(10, "IN", 0)).toMatchObject({ ok: false, reason: "INVALID_QUANTITY" });
    expect(checkMovement(10, "OUT", 2.5)).toMatchObject({ ok: false, reason: "INVALID_QUANTITY" });
  });
});

describe("stockStatus", () => {
  it.each([
    [0, 1, "OUT_OF_STOCK"],
    [-2, 0, "OUT_OF_STOCK"],
    [1, 1, "REORDER"],
    [2, 3, "REORDER"],
    [2, 1, "OK"],
    [1, 0, "OK"],
  ] as const)("balance %i with minimum %i is %s", (balance, minimum, expected) => {
    expect(stockStatus(balance, minimum)).toBe(expected);
  });
});
