import { describe, expect, it } from "vitest";
import { hasPermission } from "@/lib/auth/permissions";
import { zodFieldErrors } from "@/lib/forms";
import { productLabel } from "@/lib/products/display";
import { STOCK_STATUS_LABELS } from "@/lib/stock/status";
import { sanitizeSearch } from "./master-data";
import { BRAND_OR_MODEL_MESSAGE, codeMatchesPrefix, parseProductFilters, productSchema } from "./products";

const CATEGORY = "7d9b2f0e-3a4c-4e1b-9f6a-2c8d5e7a1b30";
const LOCATION = "0c5e8a2d-6b1f-4d3e-8a7c-9e2b4f6d1a58";
const valid = { code: "INV-201", category_id: CATEGORY, model: "NG-H5", unit: "un", minimum_stock: "1" };

const errorsOf = (input: Record<string, unknown>) => {
  const result = productSchema.safeParse(input);
  return result.success ? {} : zodFieldErrors(result.error);
};

describe("productSchema", () => {
  it("normalizes the code and optional fields without re-casing names", () => {
    expect(
      productSchema.parse({
        ...valid,
        code: " inv-201 ",
        brand: "  northgrid  ",
        model: "  NG   H5 ",
        specification: "",
        location_id: "",
        default_supplier_id: "",
      }),
    ).toEqual({
      code: "INV-201",
      category_id: CATEGORY,
      brand: "northgrid",
      model: "NG H5",
      specification: null,
      unit: "un",
      minimum_stock: 1,
      location_id: null,
      default_supplier_id: null,
    });
  });

  it("has no stock field: stock is derived from the ledger", () => {
    const parsed = productSchema.parse({ ...valid, balance: "50", current_stock: "50" });
    expect(parsed).not.toHaveProperty("balance");
    expect(parsed).not.toHaveProperty("current_stock");
  });

  it("requires code, category, unit, minimum stock and at least brand or model", () => {
    expect(errorsOf({})).toEqual({
      code: "Indique o código.",
      category_id: "Escolha a categoria.",
      brand: BRAND_OR_MODEL_MESSAGE,
      model: BRAND_OR_MODEL_MESSAGE,
      unit: "Escolha a unidade.",
      minimum_stock: "Indique o stock mínimo.",
    });
  });

  describe("brand / model (model may be unknown)", () => {
    const base = { code: "EVC-401", category_id: CATEGORY, unit: "un", minimum_stock: "2" };

    it("accepts brand only: model is NULL, never placeholder text", () => {
      const parsed = productSchema.parse({ ...base, brand: "Voltaris", model: "" });
      expect(parsed).toMatchObject({ brand: "Voltaris", model: null });
    });

    it("accepts model only", () => {
      expect(productSchema.parse({ ...base, brand: "", model: "ABC" })).toMatchObject({ brand: null, model: "ABC" });
    });

    it.each([
      [{}, "both missing"],
      [{ brand: "", model: "" }, "both empty"],
      [{ brand: "   ", model: "\t " }, "both whitespace"],
      [{ brand: null, model: null }, "both null"],
    ] as [Record<string, string | null>, string][])("rejects %j (%s)", (fields) => {
      expect(errorsOf({ ...base, ...fields })).toEqual({ brand: BRAND_OR_MODEL_MESSAGE, model: BRAND_OR_MODEL_MESSAGE });
    });

    it("normalizes whitespace-only values to NULL", () => {
      expect(productSchema.parse({ ...base, brand: "  Voltaris ", model: "   " })).toMatchObject({ brand: "Voltaris", model: null });
      expect(productSchema.parse({ ...base, brand: "   ", model: " ABC " })).toMatchObject({ brand: null, model: "ABC" });
    });

    it("still limits lengths", () => {
      expect(errorsOf({ ...base, brand: "x".repeat(61) }).brand).toBe("Máximo de 60 caracteres.");
      expect(errorsOf({ ...base, brand: "Voltaris", model: "x".repeat(121) }).model).toBe("Máximo de 120 caracteres.");
    });
  });

  it.each(["INV001", "INV-", "INV-01", "I-201", "INV-201-A", "IN V-201", "INVÉ-201"])("rejects code %s", (code) => {
    expect(errorsOf({ ...valid, code }).code).toMatch(/PREFIXO-NÚMERO/);
  });

  it.each(["INV-201", "EVC-412", "BAT-301", "PAN-1234"])("accepts code %s", (code) => {
    expect(productSchema.safeParse({ ...valid, code }).success).toBe(true);
  });

  it("rejects negative, fractional and non-numeric minimum stock", () => {
    expect(errorsOf({ ...valid, minimum_stock: "-1" }).minimum_stock).toBe("O stock mínimo não pode ser negativo.");
    expect(errorsOf({ ...valid, minimum_stock: "1.5" }).minimum_stock).toBe("Indique um número inteiro.");
    expect(errorsOf({ ...valid, minimum_stock: "abc" }).minimum_stock).toBe("Indique um número inteiro.");
  });

  it("rejects relation ids that are not UUIDs", () => {
    expect(errorsOf({ ...valid, category_id: "Inverters" }).category_id).toBe("Escolha uma categoria válida.");
    expect(errorsOf({ ...valid, location_id: "A-01-01" }).location_id).toBe("Escolha uma localização válida.");
    expect(errorsOf({ ...valid, default_supplier_id: "x" }).default_supplier_id).toBe("Escolha um fornecedor válido.");
  });

  it("checks that the code starts with the category prefix", () => {
    expect(codeMatchesPrefix("INV-201", "INV")).toBe(true);
    expect(codeMatchesPrefix("INVX-201", "INV")).toBe(false);
    expect(codeMatchesPrefix("BAT-301", "INV")).toBe(false);
  });
});

describe("parseProductFilters", () => {
  it("accepts valid filters and combines them", () => {
    expect(
      parseProductFilters(
        { q: "northgrid", categoria: CATEGORY, localizacao: LOCATION, estado: "ativos", stock: "REORDER" },
        sanitizeSearch,
      ),
    ).toEqual({ q: "northgrid", categoryId: CATEGORY, location: LOCATION, active: "ativos", stock: "REORDER" });
  });

  it("drops invalid values instead of passing them to PostgREST", () => {
    expect(
      parseProductFilters(
        { q: "a,b)", categoria: "1 or 1=1", localizacao: "../x", estado: "active", stock: "EMPTY" },
        sanitizeSearch,
      ),
    ).toEqual({ q: "a b", categoryId: null, location: null, active: "todos", stock: "todos" });
    expect(parseProductFilters({ localizacao: "sem" }, sanitizeSearch).location).toBe("sem");
  });
});

describe("display", () => {
  it("labels stock statuses in Portuguese", () => {
    expect(STOCK_STATUS_LABELS).toEqual({ OUT_OF_STOCK: "Sem stock", REORDER: "Repor stock", OK: "OK" });
  });

  it("builds the product label from brand and model", () => {
    expect(productLabel({ brand: "Northgrid", model: "20K" })).toBe("Northgrid 20K");
    expect(productLabel({ brand: null, model: "Coplanar" })).toBe("Coplanar");
    expect(productLabel({ brand: "Voltaris", model: null })).toBe("Voltaris");
    expect(productLabel({ brand: null, model: null })).toBe("—");
  });

  it("only admins manage products", () => {
    expect(hasPermission("admin", "products:manage")).toBe(true);
    expect(hasPermission("operator", "products:manage")).toBe(false);
    expect(hasPermission("viewer", "products:manage")).toBe(false);
  });
});
