import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * registerMovementAction: early permission refusal and cache invalidation.
 * The RPC remains the authority (covered by the DB suite); these tests prove
 * the action itself never calls it for a refused role/type.
 */

const revalidatePath = vi.fn();
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});
const registerMovement = vi.fn();
const createClient = vi.fn(async () => ({}));
let role: "admin" | "operator" | "viewer" = "admin";

vi.mock("next/cache", () => ({ revalidatePath: (path: string) => revalidatePath(path) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("@/lib/auth/session", () => ({ requireActiveUser: async () => ({ id: "u1", name: "Utilizador", role }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => createClient() }));
vi.mock("@/services/movements", () => ({ registerMovement: (...args: unknown[]) => registerMovement(...args) }));

const { registerMovementAction } = await import("./actions");
const { FORBIDDEN_ERROR } = await import("@/lib/db/errors");

const PRODUCT = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  role = "admin";
  revalidatePath.mockClear();
  redirect.mockClear();
  createClient.mockClear();
  registerMovement.mockReset();
});

describe("registerMovementAction refusals (before any write)", () => {
  it("operator → ADJUSTMENT_IN is refused: no RPC, no client, no revalidation, no redirect", async () => {
    role = "operator";
    const result = await registerMovementAction(
      { status: "idle" },
      form({ product_id: PRODUCT, type: "ADJUSTMENT_IN", quantity: "1", notes: "contagem" }),
    );
    expect(result).toMatchObject({ status: "error", fieldErrors: { type: expect.stringMatching(/não permitido/) } });
    expect(registerMovement).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("viewer → any movement is refused with FORBIDDEN_ERROR and nothing is called", async () => {
    role = "viewer";
    const result = await registerMovementAction({ status: "idle" }, form({ product_id: PRODUCT, type: "IN", quantity: "1" }));
    expect(result).toMatchObject({ status: "error", message: FORBIDDEN_ERROR });
    expect(registerMovement).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});

describe("registerMovementAction invalidation", () => {
  it("after a successful movement revalidates movements, products, the product page and the dashboard", async () => {
    registerMovement.mockResolvedValue({ ok: true, movementId: "m1", balanceAfter: 16, createdAt: "2026-10-06T10:00:00Z" });
    await expect(
      registerMovementAction({ status: "idle" }, form({ product_id: PRODUCT, type: "IN", quantity: "1" })),
    ).rejects.toThrow("NEXT_REDIRECT /movimentacoes/nova?registada=m1");
    expect(revalidatePath.mock.calls.map(([path]) => path)).toEqual([
      "/movimentacoes",
      "/produtos",
      `/produtos/${PRODUCT}`,
      "/dashboard",
    ]);
  });

  it("does not revalidate anything when the database refuses the movement", async () => {
    registerMovement.mockResolvedValue({ ok: false, message: "Stock insuficiente." });
    const result = await registerMovementAction({ status: "idle" }, form({ product_id: PRODUCT, type: "OUT", quantity: "99" }));
    expect(result).toMatchObject({ status: "error", message: "Stock insuficiente." });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
});
