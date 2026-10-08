import type { Tables } from "@/types/database";
import type { ProjectInput, ProjectStatus } from "@/validation/master-data";
import { failLoad, searchFilter, toMutationResult, type DbClient, type MutationResult } from "./shared";

export type Project = Tables<"projects">;

const COLUMNS = "id, name, client, reference, status, notes, created_at, updated_at";

/** Projects have no active flag: "cancelled"/"completed" play that role. */
export async function listProjects(
  client: DbClient,
  filters: { q?: string; status?: ProjectStatus | "todos" } = {},
): Promise<Project[]> {
  let query = client.from("projects").select(COLUMNS).order("created_at", { ascending: false }).limit(500);
  if (filters.status && filters.status !== "todos") query = query.eq("status", filters.status);
  if (filters.q) query = query.or(searchFilter(["name", "client", "reference"], filters.q));

  const { data, error } = await query;
  if (error) failLoad("os projetos", error);
  return data;
}

export async function getProject(client: DbClient, id: string): Promise<Project | null> {
  const { data, error } = await client.from("projects").select(COLUMNS).eq("id", id).maybeSingle();
  if (error) failLoad("o projeto", error);
  return data;
}

export async function createProject(client: DbClient, input: ProjectInput): Promise<MutationResult> {
  return toMutationResult(await client.from("projects").insert(input).select("id").single());
}

export async function updateProject(client: DbClient, id: string, input: ProjectInput): Promise<MutationResult> {
  return toMutationResult(await client.from("projects").update(input).eq("id", id).select("id").single());
}

export async function setProjectStatus(client: DbClient, id: string, status: ProjectStatus): Promise<MutationResult> {
  return toMutationResult(await client.from("projects").update({ status }).eq("id", id).select("id").single());
}
