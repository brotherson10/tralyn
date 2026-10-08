import { describe, expect, it } from "vitest";
import { zodFieldErrors } from "@/lib/forms";
import {
  categorySchema,
  locationSchema,
  parseActiveFilter,
  parseProjectStatusFilter,
  PROJECT_STATUS_LABELS,
  projectSchema,
  sanitizeSearch,
  supplierSchema,
} from "./master-data";

/** Same extraction the Server Actions use (first message per field). */
const errorsOf = (result: { success: boolean; error?: Parameters<typeof zodFieldErrors>[0] }) =>
  result.error ? zodFieldErrors(result.error) : {};

describe("categorySchema", () => {
  it("normalizes name, prefix and empty description", () => {
    expect(categorySchema.parse({ name: "  EV   Chargers ", prefix: " evc ", description: "   " })).toEqual({
      name: "EV Chargers",
      prefix: "EVC",
      description: null,
    });
  });

  it("requires name and prefix", () => {
    expect(errorsOf(categorySchema.safeParse({ name: " ", prefix: "", description: "" }))).toEqual({
      name: "Indique o nome.",
      prefix: "Indique o prefixo.",
    });
  });

  it.each(["I", "INVERSORES01", "IN V", "INVÉ", "IN-V"])("rejects prefix %s (same rule as the DB check)", (prefix) => {
    expect(errorsOf(categorySchema.safeParse({ name: "X", prefix })).prefix).toMatch(/2 a 10 letras/);
  });
});

describe("locationSchema", () => {
  it("keeps the code as typed (trimmed) and nulls empty optionals", () => {
    expect(locationSchema.parse({ code: " A-01-01 ", zone: "A", shelf: "", position: "01", description: "" })).toEqual({
      code: "A-01-01",
      zone: "A",
      shelf: null,
      position: "01",
      description: null,
    });
  });

  it("requires the code and limits lengths", () => {
    expect(errorsOf(locationSchema.safeParse({ code: "" })).code).toBe("Indique o código.");
    expect(errorsOf(locationSchema.safeParse({ code: "X", shelf: "1".repeat(21) })).shelf).toBe("Máximo de 20 caracteres.");
  });
});

describe("supplierSchema", () => {
  it("accepts an empty email and phone", () => {
    const parsed = supplierSchema.parse({ name: "Fornecedor", email: "", phone: "", contact_person: "", notes: "" });
    expect(parsed).toMatchObject({ email: null, phone: null, contact_person: null, notes: null });
  });

  it("validates and normalizes the email only when filled in", () => {
    expect(supplierSchema.parse({ name: "F", email: " Compras@Exemplo.PT " }).email).toBe("compras@exemplo.pt");
    expect(errorsOf(supplierSchema.safeParse({ name: "F", email: "sem-arroba" })).email).toBe("Indique um email válido.");
  });

  it("validates phone numbers", () => {
    expect(supplierSchema.parse({ name: "F", phone: "+351 210 000 000" }).phone).toBe("+351 210 000 000");
    expect(errorsOf(supplierSchema.safeParse({ name: "F", phone: "ligar ao João" })).phone).toMatch(/telefone válido/);
  });

  it("keeps line breaks in notes", () => {
    expect(supplierSchema.parse({ name: "F", notes: " linha 1\r\nlinha 2 " }).notes).toBe("linha 1\nlinha 2");
  });
});

describe("projectSchema", () => {
  it("accepts exactly the database statuses", () => {
    for (const status of ["active", "completed", "cancelled"]) {
      expect(projectSchema.parse({ name: "Obra", status }).status).toBe(status);
    }
    expect(errorsOf(projectSchema.safeParse({ name: "Obra", status: "Ativo" })).status).toBe("Escolha um estado válido.");
  });

  it("maps statuses to Portuguese labels", () => {
    expect(PROJECT_STATUS_LABELS).toEqual({ active: "Ativo", completed: "Concluído", cancelled: "Cancelado" });
  });
});

describe("filters and search", () => {
  it("parses list filters with safe defaults", () => {
    expect(parseActiveFilter("inativos")).toBe("inativos");
    expect(parseActiveFilter("qualquer")).toBe("todos");
    expect(parseProjectStatusFilter("completed")).toBe("completed");
    expect(parseProjectStatusFilter(["completed"])).toBe("todos");
  });

  it("strips PostgREST/LIKE syntax from the search term", () => {
    expect(sanitizeSearch("  inv,prefix.eq.X)  ")).toBe("inv prefix.eq.X");
    expect(sanitizeSearch("100%_*")).toBe("100");
    expect(sanitizeSearch("10.24 kWh")).toBe("10.24 kWh");
    expect(sanitizeSearch(undefined)).toBe("");
    expect(sanitizeSearch("x".repeat(200))).toHaveLength(80);
  });
});
