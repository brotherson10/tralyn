import type { Tables } from "@/types/database";
import type { ActiveFilter, CategoryInput } from "@/validation/master-data";
import {
  duplicateResult,
  escapeLike,
  failLoad,
  searchFilter,
  toMutationResult,
  type DbClient,
  type MutationResult,
} from "./shared";

export type Category = Tables<"categories">;

const COLUMNS = "id, name, prefix, description, active, created_at, updated_at";

export async function listCategories(
  client: DbClient,
  filters: { q?: string; active?: ActiveFilter } = {},
): Promise<Category[]> {
  let query = client.from("categories").select(COLUMNS).order("name").limit(500);
  if (filters.active === "ativos") query = query.eq("active", true);
  if (filters.active === "inativos") query = query.eq("active", false);
  if (filters.q) query = query.or(searchFilter(["name", "prefix", "description"], filters.q));

  const { data, error } = await query;
  if (error) failLoad("as categorias", error);
  return data;
}

export async function getCategory(client: DbClient, id: string): Promise<Category | null> {
  const { data, error } = await client.from("categories").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) failLoad("a categoria", error);
  return data;
}

/** The UNIQUE constraint on name is case-sensitive; also refuse "Inverters" vs "inverters". */
async function nameTaken(client: DbClient, name: string, exceptId?: string): Promise<boolean> {
  let query = client.from("categories").select("id").ilike("name", escapeLike(name)).limit(1);
  if (exceptId) query = query.neq("id", exceptId);
  const { data } = await query;
  return (data?.length ?? 0) > 0;
}

export async function createCategory(client: DbClient, input: CategoryInput): Promise<MutationResult> {
  if (await nameTaken(client, input.name)) {
    return duplicateResult("name", "Já existe uma categoria com este nome.");
  }
  return toMutationResult(await client.from("categories").insert(input).select("id").single());
}

export async function updateCategory(client: DbClient, id: string, input: CategoryInput): Promise<MutationResult> {
  if (await nameTaken(client, input.name, id)) {
    return duplicateResult("name", "Já existe uma categoria com este nome.");
  }
  return toMutationResult(await client.from("categories").update(input).eq("id", id).select("id").single());
}

export async function setCategoryActive(client: DbClient, id: string, active: boolean): Promise<MutationResult> {
  return toMutationResult(await client.from("categories").update({ active }).eq("id", id).select("id").single());
}
