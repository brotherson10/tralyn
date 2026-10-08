import type { Tables } from "@/types/database";
import type { ActiveFilter, LocationInput } from "@/validation/master-data";
import {
  duplicateResult,
  escapeLike,
  failLoad,
  searchFilter,
  toMutationResult,
  type DbClient,
  type MutationResult,
} from "./shared";

export type Location = Tables<"locations">;

const COLUMNS = "id, code, zone, shelf, position, description, active, created_at, updated_at";

export async function listLocations(
  client: DbClient,
  filters: { q?: string; active?: ActiveFilter } = {},
): Promise<Location[]> {
  let query = client.from("locations").select(COLUMNS).order("code").limit(500);
  if (filters.active === "ativos") query = query.eq("active", true);
  if (filters.active === "inativos") query = query.eq("active", false);
  if (filters.q) query = query.or(searchFilter(["code", "zone", "shelf", "position", "description"], filters.q));

  const { data, error } = await query;
  if (error) failLoad("as localizações", error);
  return data;
}

export async function getLocation(client: DbClient, id: string): Promise<Location | null> {
  const { data, error } = await client.from("locations").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) failLoad("a localização", error);
  return data;
}

/** The UNIQUE constraint on code is case-sensitive; also refuse "a-01-01" vs "A-01-01". */
async function codeTaken(client: DbClient, code: string, exceptId?: string): Promise<boolean> {
  let query = client.from("locations").select("id").ilike("code", escapeLike(code)).limit(1);
  if (exceptId) query = query.neq("id", exceptId);
  const { data } = await query;
  return (data?.length ?? 0) > 0;
}

export async function createLocation(client: DbClient, input: LocationInput): Promise<MutationResult> {
  if (await codeTaken(client, input.code)) {
    return duplicateResult("code", "Já existe uma localização com este código.");
  }
  return toMutationResult(await client.from("locations").insert(input).select("id").single());
}

export async function updateLocation(client: DbClient, id: string, input: LocationInput): Promise<MutationResult> {
  if (await codeTaken(client, input.code, id)) {
    return duplicateResult("code", "Já existe uma localização com este código.");
  }
  return toMutationResult(await client.from("locations").update(input).eq("id", id).select("id").single());
}

export async function setLocationActive(client: DbClient, id: string, active: boolean): Promise<MutationResult> {
  return toMutationResult(await client.from("locations").update({ active }).eq("id", id).select("id").single());
}
