import { describe, expect, it } from "vitest";
import { operationalMovementTypesFor } from "@/lib/auth/permissions";
import { zodFieldErrors } from "@/lib/forms";
import { MOVEMENT_TYPE_LABELS } from "@/lib/stock/ledger";
import { MOVEMENT_UNEXPECTED_ERROR, movementErrorMessage } from "@/lib/stock/movement-errors";
import { sanitizeSearch } from "./master-data";
import { dayStartInLisbon, movementSchema, nextDayStartInLisbon, parseMovementFilters } from "./movements";

const PRODUCT = "3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const base = { product_id: PRODUCT, type: "IN", quantity: "10" };
const errorsOf = (input: Record<string, unknown>) => {
  const result = movementSchema.safeParse(input);
  return result.success ? {} : zodFieldErrors(result.error);
};

describe("movementSchema", () => {
  it("accepts a positive integer quantity and nulls empty optionals", () => {
    expect(movementSchema.parse({ ...base, project_id: "", document_reference: "  ", notes: "" })).toEqual({
      product_id: PRODUCT,
      type: "IN",
      quantity: 10,
      project_id: null,
      document_reference: null,
      notes: null,
    });
  });

  it.each([
    ["0", "A quantidade tem de ser maior que zero. O tipo define se é entrada ou saída."],
    ["-5", "A quantidade tem de ser maior que zero. O tipo define se é entrada ou saída."],
    ["2.5", "Indique um número inteiro, sem casas decimais."],
    ["", "Indique a quantidade."],
    ["abc", "Indique um número inteiro, sem casas decimais."],
  ])("rejects quantity %j", (quantity, message) => {
    expect(errorsOf({ ...base, quantity }).quantity).toBe(message);
  });

  it("never accepts OPENING_BALANCE or unknown types from the operational form", () => {
    expect(errorsOf({ ...base, type: "OPENING_BALANCE" }).type).toBe("Escolha o tipo de movimentação.");
    expect(errorsOf({ ...base, type: "AJUSTE" }).type).toBe("Escolha o tipo de movimentação.");
  });

  it("has no user, date or balance fields (they come from the database)", () => {
    const parsed = movementSchema.parse({ ...base, user_id: "x", created_at: "2020-01-01", balance: "99" });
    expect(Object.keys(parsed).sort()).toEqual(["document_reference", "notes", "product_id", "project_id", "quantity", "type"]);
  });

  it("requires notes explaining adjustments", () => {
    for (const type of ["ADJUSTMENT_IN", "ADJUSTMENT_OUT"]) {
      expect(errorsOf({ ...base, type }).notes).toMatch(/explique o motivo/);
      expect(movementSchema.safeParse({ ...base, type, notes: "Contagem física encontrou 2 unidades." }).success).toBe(true);
    }
    expect(errorsOf({ ...base, type: "OUT" }).notes).toBeUndefined();
  });

  it("validates product and project ids and text lengths", () => {
    expect(errorsOf({ ...base, product_id: "INV-201" }).product_id).toBe("Escolha um produto válido.");
    expect(errorsOf({ ...base, project_id: "Obra X" }).project_id).toBe("Escolha um projeto válido.");
    expect(errorsOf({ ...base, document_reference: "x".repeat(121) }).document_reference).toBe("Máximo de 120 caracteres.");
    expect(errorsOf({ ...base, notes: "x".repeat(1001) }).notes).toBe("Máximo de 1000 caracteres.");
  });
});

describe("types per role and labels", () => {
  it("offers IN/OUT/adjustments to admins, IN/OUT to operators, nothing to viewers — never OPENING_BALANCE", () => {
    expect(operationalMovementTypesFor("admin")).toEqual(["IN", "OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"]);
    expect(operationalMovementTypesFor("operator")).toEqual(["IN", "OUT"]);
    expect(operationalMovementTypesFor("viewer")).toEqual([]);
  });

  it("uses the Portuguese labels", () => {
    expect(MOVEMENT_TYPE_LABELS).toEqual({
      OPENING_BALANCE: "Saldo inicial",
      IN: "Entrada",
      OUT: "Saída",
      ADJUSTMENT_IN: "Ajuste +",
      ADJUSTMENT_OUT: "Ajuste -",
    });
  });
});

describe("movementErrorMessage", () => {
  it("reports insufficient stock with the available quantity and unit", () => {
    expect(movementErrorMessage({ code: "P0001", message: "INSUFFICIENT_STOCK", hint: "7" }, "un")).toEqual({
      message: "Stock insuficiente. Disponível: 7 un.",
      fieldErrors: { quantity: "Stock insuficiente. Disponível: 7 un." },
    });
  });

  it.each([
    ["PRODUCT_INACTIVE", "product_id"],
    ["PRODUCT_NOT_FOUND", "product_id"],
    ["PROJECT_NOT_ACTIVE", "project_id"],
    ["PROJECT_NOT_FOUND", "project_id"],
    ["INVALID_QUANTITY", "quantity"],
    ["ADJUSTMENT_NOTES_REQUIRED", "notes"],
    ["FORBIDDEN", "type"],
  ])("maps %s to the %s field", (message, field) => {
    expect(Object.keys(movementErrorMessage({ code: "P0001", message }).fieldErrors ?? {})).toEqual([field]);
  });

  it("never echoes unknown database text", () => {
    const result = movementErrorMessage({ code: "XX000", message: 'relation "private.secret" does not exist' });
    expect(result).toEqual({ message: MOVEMENT_UNEXPECTED_ERROR });
  });
});

describe("history filters", () => {
  it("parses valid filters and ignores invalid ones", () => {
    expect(
      parseMovementFilters(
        { q: "inv", tipo: "OUT", produto: PRODUCT, projeto: "x", de: "2026-07-28", ate: "2026-02-30", pagina: "3" },
        sanitizeSearch,
      ),
    ).toEqual({ q: "inv", type: "OUT", productId: PRODUCT, projectId: null, from: "2026-07-28", to: null, page: 3 });
    expect(parseMovementFilters({ pagina: "-1", tipo: "DROP" }, sanitizeSearch)).toMatchObject({ page: 1, type: null });
  });

  it("converts Lisbon local days to UTC boundaries (summer and winter time)", () => {
    expect(dayStartInLisbon("2026-07-28")).toBe("2026-07-27T23:00:00.000Z");
    expect(nextDayStartInLisbon("2026-07-28")).toBe("2026-07-28T23:00:00.000Z");
    expect(dayStartInLisbon("2026-01-15")).toBe("2026-01-15T00:00:00.000Z");
    expect(nextDayStartInLisbon("2026-12-31")).toBe("2027-01-01T00:00:00.000Z");
  });
});
