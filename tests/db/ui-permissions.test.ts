import { afterAll, describe, expect, it } from "vitest";
import { canRegisterMovement } from "@/lib/auth/permissions";
import { APP_ROLES } from "@/lib/auth/roles";
import { MOVEMENT_TYPES } from "@/lib/stock/ledger";
import { closeDb, createProduct, createUser, insertMovementAsSuperuser, signIn } from "./helpers";

afterAll(closeDb);

/**
 * The UI permission map must mirror the database exactly. The database stays
 * the authority; this test only guarantees the UI never offers an action the
 * RPC refuses, nor hides one it allows.
 */
describe("UI permissions mirror register_stock_movement", () => {
  it.each(APP_ROLES)("%s", async (role) => {
    const user = await createUser(role);
    const client = await signIn(user);
    const product = await createProduct();
    await insertMovementAsSuperuser(product.id, "IN", 10, user.id);

    for (const type of MOVEMENT_TYPES) {
      const { error } = await client.rpc("register_stock_movement", {
        p_product_id: product.id,
        p_type: type,
        p_quantity: 1,
      });
      const allowedByDatabase = error?.message !== "FORBIDDEN";
      expect(allowedByDatabase, `${role} / ${type}`).toBe(canRegisterMovement(role, type));
    }
  });
});
