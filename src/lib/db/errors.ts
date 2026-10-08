/**
 * Maps PostgreSQL / PostgREST errors to safe, user-facing Portuguese messages.
 * Raw database messages are never returned to the UI.
 */

export interface DbErrorLike {
  code?: string;
  message?: string;
  details?: string | null;
}

export type FieldErrors = Record<string, string>;

export interface FriendlyError {
  message: string;
  fieldErrors?: FieldErrors;
}

/** Constraint name → field + message, for UNIQUE and CHECK violations. */
const CONSTRAINT_MESSAGES: Record<string, { field: string; message: string }> = {
  categories_name_key: { field: "name", message: "Já existe uma categoria com este nome." },
  categories_prefix_key: { field: "prefix", message: "Este prefixo já está a ser usado por outra categoria." },
  categories_prefix_format: {
    field: "prefix",
    message: "Use 2 a 10 letras ou números, sem espaços nem acentos (ex.: INV).",
  },
  categories_name_not_blank: { field: "name", message: "Indique o nome." },
  locations_code_key: { field: "code", message: "Já existe uma localização com este código." },
  locations_code_not_blank: { field: "code", message: "Indique o código." },
  suppliers_name_unique_idx: { field: "name", message: "Já existe um fornecedor com este nome." },
  suppliers_name_not_blank: { field: "name", message: "Indique o nome." },
  suppliers_email_format: { field: "email", message: "Indique um email válido." },
  projects_reference_key: { field: "reference", message: "Já existe um projeto com esta referência." },
  projects_name_not_blank: { field: "name", message: "Indique o nome." },
  products_code_key: { field: "code", message: "Já existe um produto com este código." },
  products_code_format: { field: "code", message: "O código não pode estar vazio nem ter espaços nas pontas." },
  products_qr_code_key: { field: "code", message: "Este identificador QR já está associado a outro produto." },
  products_model_not_blank: { field: "model", message: "O modelo não pode ficar em branco; deixe vazio se for desconhecido." },
  products_brand_not_blank: { field: "brand", message: "A marca não pode ficar em branco; deixe vazio se for desconhecida." },
  products_brand_or_model_present: { field: "model", message: "Indique pelo menos a marca ou o modelo." },
  products_unit_not_blank: { field: "unit", message: "Escolha a unidade." },
  products_minimum_stock_non_negative: { field: "minimum_stock", message: "O stock mínimo não pode ser negativo." },
  products_category_id_fkey: { field: "category_id", message: "A categoria escolhida não existe." },
  products_location_id_fkey: { field: "location_id", message: "A localização escolhida não existe." },
  products_default_supplier_id_fkey: { field: "default_supplier_id", message: "O fornecedor escolhido não existe." },
};

export const GENERIC_SAVE_ERROR = "Não foi possível guardar as alterações. Tente novamente.";
export const FORBIDDEN_ERROR = "Não tem permissão para realizar esta operação.";
export const NOT_FOUND_OR_FORBIDDEN_ERROR = "O registo não existe ou não tem permissão para o alterar.";
export const CHECK_FIELDS_ERROR = "Verifique os campos assinalados.";

export function constraintName(error: DbErrorLike): string | null {
  const text = `${error.message ?? ""} ${error.details ?? ""}`;
  return /constraint "([^"]+)"/.exec(text)?.[1] ?? null;
}

export function friendlyDbError(error: DbErrorLike): FriendlyError {
  switch (error.code) {
    case "23505":
    case "23514": {
      const known = CONSTRAINT_MESSAGES[constraintName(error) ?? ""];
      if (known) return { message: CHECK_FIELDS_ERROR, fieldErrors: { [known.field]: known.message } };
      return {
        message: error.code === "23505" ? "Já existe um registo com estes dados." : "Alguns dados não são válidos.",
      };
    }
    case "23503": {
      const known = CONSTRAINT_MESSAGES[constraintName(error) ?? ""];
      if (known) return { message: CHECK_FIELDS_ERROR, fieldErrors: { [known.field]: known.message } };
      return { message: "Este registo está associado a outros dados e não pode ser alterado desta forma." };
    }
    case "42501":
      return { message: FORBIDDEN_ERROR };
    case "PGRST116":
      // .single() found no row: missing, or hidden/blocked by RLS.
      return { message: NOT_FOUND_OR_FORBIDDEN_ERROR };
    default:
      return { message: GENERIC_SAVE_ERROR };
  }
}
