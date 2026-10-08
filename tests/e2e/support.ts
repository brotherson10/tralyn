import type { Page } from "@playwright/test";
import { createUser, db, uid, type Role, type TestUser } from "../db/helpers";

/** Shared helpers for browser tests (LOCAL Supabase only). */

export async function newUser(role: Role, name: string, opts: { active?: boolean } = {}): Promise<TestUser> {
  const user = await createUser(role, opts);
  await db().query(`update public.profiles set name = $2 where id = $1`, [user.id, name]);
  return user;
}

export async function login(page: Page, user: TestUser) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Palavra-passe", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.waitForURL(/\/dashboard$/);
}

/** Page alerts only (Next.js also renders an invisible route announcer with role="alert"). */
export function alert(page: Page) {
  return page.locator("main").getByRole("alert");
}

export function flash(page: Page) {
  return page.locator("main").getByRole("status");
}

/** Unique 2–10 char uppercase prefix. */
export function newPrefix(): string {
  return `E${uid().replace(/[^A-Z0-9]/g, "").slice(0, 7)}`;
}

/** Fixture rows created directly in the local database (setup only). */
export async function seedMasterData() {
  const tag = uid();
  const category = await db().query<{ id: string }>(
    `insert into public.categories (name, prefix, description) values ($1, $2, 'Fixture') returning id`,
    [`Fixture Cat ${tag}`, newPrefix()],
  );
  const location = await db().query<{ id: string }>(
    `insert into public.locations (code, zone) values ($1, 'Z') returning id`,
    [`FX-${tag}`],
  );
  const supplier = await db().query<{ id: string }>(
    `insert into public.suppliers (name) values ($1) returning id`,
    [`Fixture Fornecedor ${tag}`],
  );
  const project = await db().query<{ id: string }>(
    `insert into public.projects (name, status) values ($1, 'active') returning id`,
    [`Fixture Projeto ${tag}`],
  );
  return {
    tag,
    categoryId: category.rows[0].id,
    locationId: location.rows[0].id,
    supplierId: supplier.rows[0].id,
    projectId: project.rows[0].id,
  };
}
