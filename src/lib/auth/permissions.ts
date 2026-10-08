/**
 * UI permissions.
 *
 * These decide what the interface OFFERS (which buttons, links and forms are
 * shown). They are NOT a security mechanism: every read and write is
 * authorized again by PostgreSQL (RLS policies and the register_stock_movement
 * RPC). A DB integration test checks that the movement rules below match the
 * RPC exactly.
 */
import { OPERATIONAL_MOVEMENT_TYPES, type MovementType, type OperationalMovementType } from "@/lib/stock/ledger";
import type { AppRole } from "./roles";

export const PERMISSIONS = [
  "inventory:read",
  "movements:in_out",
  "movements:adjust",
  "master_data:manage",
  "products:manage",
  "users:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  admin: PERMISSIONS,
  operator: ["inventory:read", "movements:in_out"],
  viewer: ["inventory:read"],
};

export function hasPermission(role: AppRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: AppRole): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * Permission needed per movement type. OPENING_BALANCE has none: opening
 * balances belong exclusively to the technical initial import, and the RPC
 * refuses them for every role.
 */
const MOVEMENT_PERMISSION: Record<MovementType, Permission | null> = {
  IN: "movements:in_out",
  OUT: "movements:in_out",
  ADJUSTMENT_IN: "movements:adjust",
  ADJUSTMENT_OUT: "movements:adjust",
  OPENING_BALANCE: null,
};

/** Movement types the UI should offer to a role (mirrors the RPC rules). */
export function movementTypesFor(role: AppRole): MovementType[] {
  return (Object.keys(MOVEMENT_PERMISSION) as MovementType[]).filter((type) => canRegisterMovement(role, type));
}

export function canRegisterMovement(role: AppRole, type: MovementType): boolean {
  const permission = MOVEMENT_PERMISSION[type];
  return permission !== null && hasPermission(role, permission);
}

/** Types the operational form offers to a role (never OPENING_BALANCE). */
export function operationalMovementTypesFor(role: AppRole): OperationalMovementType[] {
  return OPERATIONAL_MOVEMENT_TYPES.filter((type) => canRegisterMovement(role, type));
}
