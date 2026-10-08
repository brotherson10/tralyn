import type { Tables } from "@/types/database";
import type { ActiveFilter, SupplierInput } from "@/validation/master-data";
import { failLoad, searchFilter, toMutationResult, type DbClient, type MutationResult } from "./shared";

export type Supplier = Tables<"suppliers">;

const COLUMNS = "id, name, email, phone, contact_person, notes, active, created_at, updated_at";

export async function listSuppliers(
  client: DbClient,
  filters: { q?: string; active?: ActiveFilter } = {},
): Promise<Supplier[]> {
  let query = client.from("suppliers").select(COLUMNS).order("name").limit(500);
  if (filters.active === "ativos") query = query.eq("active", true);
  if (filters.active === "inativos") query = query.eq("active", false);
  if (filters.q) query = query.or(searchFilter(["name", "email", "phone", "contact_person"], filters.q));

  const { data, error } = await query;
  if (error) failLoad("os fornecedores", error);
  return data;
}

export async function getSupplier(client: DbClient, id: string): Promise<Supplier | null> {
  const { data, error } = await client.from("suppliers").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) failLoad("o fornecedor", error);
  return data;
}

// Name uniqueness is enforced case-insensitively by the suppliers_name_unique_idx index.

export async function createSupplier(client: DbClient, input: SupplierInput): Promise<MutationResult> {
  return toMutationResult(await client.from("suppliers").insert(input).select("id").single());
}

export async function updateSupplier(client: DbClient, id: string, input: SupplierInput): Promise<MutationResult> {
  return toMutationResult(await client.from("suppliers").update(input).eq("id", id).select("id").single());
}

export async function setSupplierActive(client: DbClient, id: string, active: boolean): Promise<MutationResult> {
  return toMutationResult(await client.from("suppliers").update({ active }).eq("id", id).select("id").single());
}
