import { loginSchema } from "@/lib/auth/login";

/**
 * Optional public demo access (read-only Viewer account).
 *
 * These credentials are DELIBERATELY PUBLIC: NEXT_PUBLIC_* values are inlined
 * into the browser bundle, and the same credentials are published with the
 * demo. They grant only what RLS allows a viewer; the account's password and
 * e-mail cannot be changed (private.locked_auth_users). Never put a
 * credential here that is not meant to be published.
 *
 * When either variable is missing or invalid, the demo block is not shown.
 * Next.js only inlines NEXT_PUBLIC_* variables referenced literally.
 */
export interface PublicDemoViewer {
  email: string;
  password: string;
}

export function parsePublicDemoViewer(raw: { email?: string; password?: string }): PublicDemoViewer | null {
  const parsed = loginSchema.safeParse({ email: raw.email, password: raw.password });
  return parsed.success ? parsed.data : null;
}

export function readPublicDemoViewer(): PublicDemoViewer | null {
  return parsePublicDemoViewer({
    email: process.env.NEXT_PUBLIC_DEMO_VIEWER_EMAIL,
    password: process.env.NEXT_PUBLIC_DEMO_VIEWER_PASSWORD,
  });
}
