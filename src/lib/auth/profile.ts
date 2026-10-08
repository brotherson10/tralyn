import { z } from "zod";
import { APP_ROLES, type AppRole } from "./roles";
import type { LoginNoticeKey } from "./login";

export interface CurrentUser {
  id: string;
  email: string | null;
  name: string;
  role: AppRole;
}

export type DenialReason = "no_profile" | "invalid_profile" | "inactive";

export type ProfileCheck = { ok: true; user: CurrentUser } | { ok: false; reason: DenialReason };

const profileRowSchema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1),
  role: z.enum(APP_ROLES),
  active: z.boolean(),
});

/**
 * Decides whether an authenticated user may use the application, based only
 * on the profile row read from the database (never on client-provided data).
 */
export function evaluateProfile(userId: string, email: string | null, row: unknown): ProfileCheck {
  if (row === null || row === undefined) return { ok: false, reason: "no_profile" };

  const parsed = profileRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.id !== userId) return { ok: false, reason: "invalid_profile" };
  if (!parsed.data.active) return { ok: false, reason: "inactive" };

  return {
    ok: true,
    user: { id: userId, email, name: parsed.data.name.trim(), role: parsed.data.role },
  };
}

export const DENIAL_NOTICE: Record<DenialReason, LoginNoticeKey> = {
  inactive: "conta-inativa",
  no_profile: "perfil-invalido",
  invalid_profile: "perfil-invalido",
};
