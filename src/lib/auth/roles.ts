import type { Database } from "@/types/database";

/** Roles as stored in the database (enum public.app_role). */
export type AppRole = Database["public"]["Enums"]["app_role"];

export const APP_ROLES = ["admin", "operator", "viewer"] as const satisfies readonly AppRole[];

/** Portuguese labels shown in the UI; the database keeps the English enum values. */
export const ROLE_LABELS: Record<AppRole, string> = {
  admin: "Administrador",
  operator: "Operador",
  viewer: "Consulta",
};

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

export function roleLabel(role: AppRole): string {
  return ROLE_LABELS[role];
}
