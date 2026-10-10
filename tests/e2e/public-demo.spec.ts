import { expect, test, type Page } from "@playwright/test";
import { closeDb, createUser, db } from "../db/helpers";
import { E2E_DEMO_VIEWER, E2E_PUBLIC_DEMO } from "./public-demo-fixture";
import { newUser } from "./support";

/**
 * Public demo block on /login. The build is configured once per run:
 *   npm run test:e2e                    → demo variables empty (block absent)
 *   E2E_PUBLIC_DEMO=1 npm run test:e2e  → fictitious local credentials (block present)
 */

const FILLED = "Credenciais de demonstração preenchidas. Carregue em Entrar para continuar.";

test.afterAll(closeDb);

const demoButton = (page: Page) => page.getByRole("button", { name: "Explorar demonstração" });
const demoRegion = (page: Page) => page.getByRole("region", { name: "Demonstração pública" });
const authCookies = async (page: Page) => (await page.context().cookies()).filter((c) => c.name.startsWith("sb-"));

test.describe("without demo configuration", () => {
  test.skip(E2E_PUBLIC_DEMO, "build configured with demo credentials");

  test("the demo block is not rendered and the e-mail field gets focus", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Entrar" })).toBeVisible();
    await expect(demoRegion(page)).toHaveCount(0);
    await expect(demoButton(page)).toHaveCount(0);
    await expect(page.getByText("ou entre com a sua conta")).toHaveCount(0);
    await expect(page.getByLabel("Email")).toBeFocused();
  });
});

test.describe("with demo configuration", () => {
  test.skip(!E2E_PUBLIC_DEMO, "run with E2E_PUBLIC_DEMO=1");

  test.beforeAll(async () => {
    // Local stack only: (re)create the fictitious viewer that matches the build.
    await db().query(`delete from auth.users where email = $1`, [E2E_DEMO_VIEWER.email]);
    const user = await createUser("viewer", { email: E2E_DEMO_VIEWER.email, password: E2E_DEMO_VIEWER.password });
    await db().query(`update public.profiles set name = 'Viewer Demo E2E' where id = $1`, [user.id]);
  });

  test("shows the read-only notice above the normal login", async ({ page }) => {
    await page.goto("/login");
    await expect(demoRegion(page)).toBeVisible();
    await expect(demoRegion(page)).toContainText("Acesso de leitura — dados fictícios.");
    await expect(page.getByText("ou entre com a sua conta")).toBeVisible();
    const demoBox = await demoRegion(page).boundingBox();
    const emailBox = await page.getByLabel("Email").boundingBox();
    expect(demoBox!.y).toBeLessThan(emailBox!.y);
  });

  test("fills the fields without signing in; Entrar then opens the read-only dashboard", async ({ page }) => {
    await page.goto("/login");
    await demoButton(page).click();

    await expect(page.getByLabel("Email")).toHaveValue(E2E_DEMO_VIEWER.email);
    await expect(page.getByLabel("Palavra-passe", { exact: true })).toHaveValue(E2E_DEMO_VIEWER.password);
    await expect(page.getByRole("button", { name: "Entrar" })).toBeFocused();
    await expect(demoRegion(page).getByText(FILLED)).toBeVisible();

    // No automatic submission: still on /login, no session cookie.
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/\/login$/);
    expect(await authCookies(page)).toEqual([]);

    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL(/\/dashboard$/);
    await expect(page.getByTestId("current-user").first()).toContainText("Viewer Demo E2E");

    await page.goto("/movimentacoes");
    await expect(page.getByRole("link", { name: "Nova movimentação" })).toHaveCount(0);
    await page.goto("/movimentacoes/nova");
    await expect(page).toHaveURL(/\/sem-permissao$/);
  });

  test("works with the keyboard only", async ({ page }) => {
    await page.goto("/login");
    await demoButton(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Email")).toHaveValue(E2E_DEMO_VIEWER.email);
    await expect(page.getByRole("button", { name: "Entrar" })).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForURL(/\/dashboard$/);
  });

  test("the normal login still works and typed credentials win", async ({ page }) => {
    const operator = await newUser("operator", "Operador Normal");
    await page.goto("/login");
    await demoButton(page).click();
    await page.getByLabel("Email").fill(operator.email);
    await page.getByLabel("Palavra-passe", { exact: true }).fill(operator.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL(/\/dashboard$/);
    await expect(page.getByTestId("current-user").first()).toContainText("Operador Normal");
  });

  test("a failed demo sign-in shows the normal error and the block can fill again", async ({ page }) => {
    await page.goto("/login");
    await demoButton(page).click();
    await page.getByLabel("Palavra-passe", { exact: true }).fill("wrong-password-123");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.locator("main").getByRole("alert")).toContainText("Email ou palavra-passe incorretos.");
    await demoButton(page).click();
    await expect(page.getByLabel("Palavra-passe", { exact: true })).toHaveValue(E2E_DEMO_VIEWER.password);
  });

  test("mobile 390×844: block fits, no horizontal overflow, demo sign-in works", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/login");
    const width = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth));
    expect(width).toBeLessThanOrEqual(390);
    const button = await demoButton(page).boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.x + button!.width).toBeLessThanOrEqual(390);
    await demoButton(page).click();
    await page.getByRole("button", { name: "Entrar" }).click();
    await page.waitForURL(/\/dashboard$/);
  });
});
