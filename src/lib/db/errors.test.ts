import { describe, expect, it } from "vitest";
import { FORBIDDEN_ERROR, friendlyDbError, GENERIC_SAVE_ERROR, NOT_FOUND_OR_FORBIDDEN_ERROR } from "./errors";

describe("friendlyDbError", () => {
  it("maps UNIQUE violations to the right field", () => {
    expect(
      friendlyDbError({
        code: "23505",
        message: 'duplicate key value violates unique constraint "categories_prefix_key"',
        details: "Key (prefix)=(INV) already exists.",
      }),
    ).toEqual({
      message: "Verifique os campos assinalados.",
      fieldErrors: { prefix: "Este prefixo já está a ser usado por outra categoria." },
    });
    expect(
      friendlyDbError({ code: "23505", message: 'violates unique constraint "suppliers_name_unique_idx"' }).fieldErrors,
    ).toEqual({ name: "Já existe um fornecedor com este nome." });
  });

  it("maps CHECK violations to the right field", () => {
    expect(
      friendlyDbError({ code: "23514", message: 'violates check constraint "suppliers_email_format"' }).fieldErrors,
    ).toEqual({ email: "Indique um email válido." });
  });

  it("maps permission errors and missing rows", () => {
    expect(friendlyDbError({ code: "42501", message: "new row violates row-level security policy" }).message).toBe(
      FORBIDDEN_ERROR,
    );
    expect(friendlyDbError({ code: "PGRST116" }).message).toBe(NOT_FOUND_OR_FORBIDDEN_ERROR);
  });

  it("never returns raw database text", () => {
    const raw = { code: "XX000", message: 'internal error at "secret_table" line 42' };
    expect(friendlyDbError(raw)).toEqual({ message: GENERIC_SAVE_ERROR });
    const unknownUnique = friendlyDbError({ code: "23505", message: 'violates unique constraint "some_internal_key"' });
    expect(JSON.stringify(unknownUnique)).not.toContain("some_internal_key");
  });
});
