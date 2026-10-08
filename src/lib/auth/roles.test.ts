import { describe, expect, it } from "vitest";
import { canRegisterMovement, hasPermission, movementTypesFor } from "./permissions";
import { APP_ROLES, isAppRole, ROLE_LABELS, roleLabel } from "./roles";

describe("role mapping", () => {
  it.each([
    ["admin", "Administrador"],
    ["operator", "Operador"],
    ["viewer", "Consulta"],
  ] as const)("%s → %s", (role, label) => {
    expect(roleLabel(role)).toBe(label);
  });

  it("covers exactly the three database roles", () => {
    expect(Object.keys(ROLE_LABELS).sort()).toEqual(["admin", "operator", "viewer"]);
  });

  it("rejects unknown role values", () => {
    for (const value of ["Administrador", "ADMIN", "superuser", "", null, undefined, 1]) {
      expect(isAppRole(value)).toBe(false);
    }
  });
});

describe("UI permissions", () => {
  it("admin manages everything", () => {
    for (const p of ["inventory:read", "movements:in_out", "movements:adjust", "master_data:manage", "users:manage"] as const) {
      expect(hasPermission("admin", p)).toBe(true);
    }
    expect(movementTypesFor("admin")).toEqual(["IN", "OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"]);
  });

  it("operator reads and does IN/OUT only", () => {
    expect(hasPermission("operator", "inventory:read")).toBe(true);
    expect(movementTypesFor("operator")).toEqual(["IN", "OUT"]);
    expect(hasPermission("operator", "movements:adjust")).toBe(false);
    expect(hasPermission("operator", "master_data:manage")).toBe(false);
    expect(hasPermission("operator", "users:manage")).toBe(false);
  });

  it("viewer is read-only", () => {
    expect(hasPermission("viewer", "inventory:read")).toBe(true);
    expect(movementTypesFor("viewer")).toEqual([]);
    expect(canRegisterMovement("viewer", "IN")).toBe(false);
  });

  it("no role can register OPENING_BALANCE (technical initial import only)", () => {
    for (const role of APP_ROLES) expect(canRegisterMovement(role, "OPENING_BALANCE"), role).toBe(false);
  });
});
