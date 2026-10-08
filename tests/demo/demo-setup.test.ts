import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { registerMovement } from "@/services/movements";
import type { Database } from "@/types/database";
import { DEMO_PASSWORD, DEMO_USERS, type DemoRole } from "../../scripts/demo/data";
import { assertDemoTarget, measureDemoState, runDemoSetup } from "../../scripts/demo/setup";
import { DEMO_VISUAL_STATE } from "../../scripts/demo/state";

/**
 * DESTRUCTIVE for the LOCAL database: runs the real demo bootstrap (reset
 * included). Separate from test:db on purpose (`npm run test:demo`).
 */

async function signIn(role: DemoRole) {
  const { apiUrl, publishableKey } = await assertDemoTarget();
  const client = createClient<Database>(apiUrl, publishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const user = DEMO_USERS.find((u) => u.key === role)!;
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: DEMO_PASSWORD });
  if (error) throw new Error(`sign-in failed for ${role}`);
  return client;
}

async function productId(client: Awaited<ReturnType<typeof signIn>>, code: string): Promise<string> {
  const { data } = await client.from("products").select("id").eq("code", code).single();
  return data!.id;
}

describe("demo bootstrap (local only)", () => {
  it("builds the pinned visual state, twice, with identical results", async () => {
    const first = await runDemoSetup();
    expect(first.canonicalImport).toEqual({ records: 35, created: 30, finalQuantity: 345, statusCounts: { OUT_OF_STOCK: 2, REORDER: 3, OK: 7 } });
    expect(first.state).toEqual(DEMO_VISUAL_STATE);

    const second = await runDemoSetup();
    expect(second).toEqual(first);
  }, 300_000);

  it("demo users have exactly their roles: viewer read-only, operator IN/OUT only, nobody creates OPENING_BALANCE", async () => {
    const { dbUrl } = await assertDemoTarget();
    const viewer = await signIn("viewer");
    const operator = await signIn("operator");
    const admin = await signIn("admin");
    const id = await productId(viewer, "BAT-301");

    expect((await viewer.from("product_stock").select("code")).data).toHaveLength(12);
    const base = { product_id: id, quantity: 1, project_id: null, document_reference: null, notes: "Teste de permissões." };
    expect(await registerMovement(viewer, { ...base, type: "IN" })).toMatchObject({ ok: false });
    expect(await registerMovement(operator, { ...base, type: "ADJUSTMENT_IN" })).toMatchObject({ ok: false });
    const opening = await admin.rpc("register_stock_movement", { p_product_id: id, p_type: "OPENING_BALANCE", p_quantity: 1 });
    expect(opening.error?.message).toBe("FORBIDDEN");
    const overdraw = await operator.rpc("register_stock_movement", { p_product_id: await productId(operator, "BAT-302"), p_type: "OUT", p_quantity: 1 });
    expect(overdraw.error?.message).toBe("INSUFFICIENT_STOCK");

    // Every refused attempt left the demo untouched.
    expect(await measureDemoState(dbUrl)).toEqual(DEMO_VISUAL_STATE);
  }, 60_000);

  it("refuses a hosted signal before touching the database", async () => {
    const { dbUrl } = await assertDemoTarget();
    const run = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/demo-setup.ts"], {
      encoding: "utf8",
      env: { ...process.env, SUPABASE_PROJECT_REF: "testprojectrefabcdef" },
      timeout: 120_000,
    });
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/^RECUSADO — Alvo recusado.*SUPABASE_PROJECT_REF/);
    expect(run.stdout).toBe("");
    expect(await measureDemoState(dbUrl)).toEqual(DEMO_VISUAL_STATE);
  }, 120_000);
});
