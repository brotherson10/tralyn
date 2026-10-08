import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { friendlyDbError, type FieldErrors } from "@/lib/db/errors";
import type { Database } from "@/types/database";

/**
 * Services receive the Supabase client of the signed-in user, so every query
 * runs under RLS. There is deliberately no service-role path here.
 */
export type DbClient = SupabaseClient<Database>;

export type MutationResult = { ok: true; id: string } | { ok: false; message: string; fieldErrors?: FieldErrors };

export class DataLoadError extends Error {
  constructor(what: string) {
    super(`Não foi possível carregar ${what}.`);
    this.name = "DataLoadError";
  }
}

export function failLoad(what: string, error: PostgrestError): never {
  console.error(`[data] failed to load ${what}`, { code: error.code });
  throw new DataLoadError(what);
}

export function toMutationResult(result: { data: { id: string } | null; error: PostgrestError | null }): MutationResult {
  if (result.error || !result.data) {
    const friendly = friendlyDbError(result.error ?? { code: "PGRST116" });
    if (result.error && !["23503", "23505", "23514", "42501", "PGRST116"].includes(result.error.code)) {
      console.error("[data] mutation failed", { code: result.error.code });
    }
    return { ok: false, ...friendly };
  }
  return { ok: true, id: result.data.id };
}

export function duplicateResult(field: string, message: string): MutationResult {
  return { ok: false, message: "Verifique os campos assinalados.", fieldErrors: { [field]: message } };
}

/** Escapes LIKE wildcards so ilike() works as a case-insensitive equality check. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Builds a PostgREST `or` filter searching `term` in several columns (term must be sanitized). */
export function searchFilter(columns: readonly string[], term: string): string {
  return columns.map((column) => `${column}.ilike.%${term}%`).join(",");
}
