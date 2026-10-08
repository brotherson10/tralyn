import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Master-data Server Actions refuse non-admins before touching the database
 * (runFormAction / runSimpleAction). RLS still rejects the write if this check
 * were bypassed (covered by the DB suite).
 */

const createCategory = vi.fn();
const setCategoryActive = vi.fn();
const createClient = vi.fn(async () => ({}));
const redirect = vi.fn();
let role: "admin" | "operator" | "viewer" = "viewer";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/auth/session", () => ({ requireActiveUser: async () => ({ id: "u1", name: "Utilizador", role }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("@/services/master-data/categories", () => ({
  createCategory: (...args: unknown[]) => createCategory(...args),
  updateCategory: vi.fn(),
  setCategoryActive: (...args: unknown[]) => setCategoryActive(...args),
}));

const { createCategoryAction, setCategoryActiveAction } = await import("./actions");
const { FORBIDDEN_ERROR } = await import("@/lib/db/errors");

const CATEGORY = "22222222-2222-4222-8222-222222222222";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  createCategory.mockReset();
  setCategoryActive.mockReset();
  createClient.mockClear();
  redirect.mockClear();
});

describe.each(["viewer", "operator"] as const)("%s calling admin-only master-data actions", (current) => {
  beforeEach(() => {
    role = current;
  });

  it("create → FORBIDDEN_ERROR, no service, no database client, no redirect", async () => {
    const result = await createCategoryAction({ status: "idle" }, form({ name: "Teste", prefix: "TST" }));
    expect(result).toMatchObject({ status: "error", message: FORBIDDEN_ERROR });
    expect(createCategory).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("deactivate → FORBIDDEN_ERROR, no service, no database client, no redirect", async () => {
    const result = await setCategoryActiveAction(CATEGORY, false);
    expect(result).toEqual({ status: "error", message: FORBIDDEN_ERROR });
    expect(setCategoryActive).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
