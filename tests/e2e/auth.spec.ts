import { expect, test, type Page } from "@playwright/test";
import { closeDb, createUser, db, localStack, setProfile, type Role, type TestUser } from "../db/helpers";

/**
 * Authentication end-to-end tests (real browser, production build, LOCAL
 * Supabase). Users are created in the local stack only.
 */

const MSG = {
  invalid: "Email ou palavra-passe incorretos.",
  inactive: "A sua conta está desativada. Contacte um administrador.",
  invalidProfile: "A sua conta não está configurada corretamente. Contacte um administrador.",
  signedOut: "Sessão terminada com sucesso.",
};

test.afterAll(closeDb);

async function newUser(role: Role, name: string, opts: { active?: boolean } = {}): Promise<TestUser> {
  const user = await createUser(role, opts);
  await db().query(`update public.profiles set name = $2 where id = $1`, [user.id, name]);
  return user;
}

async function fillLogin(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Palavra-passe", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

async function login(page: Page, user: TestUser, path = "/login") {
  await page.goto(path);
  await fillLogin(page, user.email, user.password);
}

/** Page alerts only (Next.js also renders an invisible route announcer with role="alert"). */
function alert(page: Page) {
  return page.locator("main").getByRole("alert");
}

async function authCookies(page: Page) {
  return (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("sb-"));
}

test.describe("login", () => {
  test("valid credentials open the dashboard with name and role", async ({ page }) => {
    const admin = await newUser("admin", "Demo Operator");
    await login(page, admin);

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    const current = page.getByTestId("current-user").first();
    await expect(current).toContainText("Demo Operator");
    await expect(current).toContainText("Administrador");

    // Session lives in cookies, not in localStorage.
    expect((await authCookies(page)).length).toBeGreaterThan(0);
    const stored = await page.evaluate(() => Object.keys(window.localStorage));
    expect(stored.filter((key) => key.startsWith("sb-"))).toEqual([]);
  });

  test("invalid credentials show one generic message (no account enumeration)", async ({ page }) => {
    const user = await newUser("viewer", "Utilizador Existente");

    await page.goto("/login");
    await fillLogin(page, user.email, "palavra-passe-errada");
    await expect(alert(page)).toHaveText(MSG.invalid);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByLabel("Email")).toHaveValue(user.email);
    await expect(page.getByLabel("Palavra-passe", { exact: true })).toHaveValue("");

    await fillLogin(page, `nao-existe-${Date.now()}@test.local`, "qualquer-coisa");
    await expect(alert(page)).toHaveText(MSG.invalid);
    expect(await authCookies(page)).toEqual([]);
  });

  test("validates required fields on the server", async ({ page }) => {
    await page.goto("/login");
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByText("Indique o email.")).toBeVisible();
    await expect(page.getByText("Indique a palavra-passe.")).toBeVisible();
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  });

  test("the submit button is disabled while signing in (no double submit)", async ({ page }) => {
    const user = await newUser("viewer", "Utilizador Lento");
    await page.goto("/login");
    await page.route("**/login", async (route) => {
      if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Palavra-passe", { exact: true }).fill(user.password);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page.getByRole("button", { name: "A entrar…" })).toBeDisabled();
    await expect(page).toHaveURL(/\/dashboard$/);
  });
});

test.describe("route protection", () => {
  test("protected routes redirect anonymous users to /login and return after sign-in", async ({ page }) => {
    for (const path of ["/dashboard", "/produtos", "/movimentacoes", "/sem-permissao"]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path)}$`));
    }
    const user = await newUser("operator", "Operador Retorno");
    await fillLogin(page, user.email, user.password);
    await expect(page).toHaveURL(/\/sem-permissao$/);
  });

  test("a valid session can open protected routes", async ({ page }) => {
    await login(page, await newUser("viewer", "Consulta Navega"));
    await expect(page).toHaveURL(/\/dashboard$/);
    for (const [path, heading] of [
      ["/produtos", "Produtos"],
      ["/movimentacoes", "Movimentações"],
    ]) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    }
  });

  test("an authenticated user opening /login goes to /dashboard", async ({ page }) => {
    await login(page, await newUser("viewer", "Consulta Login"));
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/login");
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test("external ?next= targets are ignored (no open redirect)", async ({ page }) => {
    const user = await newUser("viewer", "Consulta Redirect");
    await login(page, user, "/login?next=https%3A%2F%2Fevil.example%2F");
    await expect(page).toHaveURL(/localhost:3100\/dashboard$/);
  });

  test("protected API routes answer 401 without a session", async ({ request }) => {
    const response = await request.get("/api/inexistente");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Não autenticado." });
  });
});

test.describe("profile checks", () => {
  test("an inactive user cannot sign in and gets no session", async ({ page }) => {
    const user = await newUser("admin", "Admin Inativo", { active: false });
    await login(page, user);
    await expect(alert(page)).toHaveText(MSG.inactive);
    expect(await authCookies(page)).toEqual([]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
  });

  test("a user deactivated during the session is signed out on the next request", async ({ page }) => {
    const user = await newUser("operator", "Operador Desativado");
    await login(page, user);
    await expect(page).toHaveURL(/\/dashboard$/);

    await setProfile(user.id, { active: false });
    await page.goto("/produtos");

    await expect(page).toHaveURL(/\/login\?motivo=conta-inativa$/);
    await expect(alert(page)).toHaveText(MSG.inactive);
    expect(await authCookies(page)).toEqual([]);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test("a user without a profile cannot sign in", async ({ page }) => {
    const user = await newUser("viewer", "Sem Perfil");
    await db().query(`delete from public.profiles where id = $1`, [user.id]);
    await login(page, user);
    await expect(alert(page)).toHaveText(MSG.invalidProfile);
    expect(await authCookies(page)).toEqual([]);
  });

  test("roles are shown with their Portuguese labels", async ({ page }) => {
    for (const [role, label] of [
      ["operator", "Operador"],
      ["viewer", "Consulta"],
    ] as const) {
      await page.context().clearCookies();
      await login(page, await newUser(role, `Papel ${label}`));
      await expect(page.getByTestId("current-user").first()).toContainText(label);
    }
  });
});

test.describe("logout", () => {
  test("ends the session, clears cookies and blocks the protected area", async ({ page }) => {
    await login(page, await newUser("admin", "Admin Sai"));
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/produtos");

    await page.getByRole("button", { name: "Sair" }).first().click();
    await expect(page).toHaveURL(/\/login\?motivo=sessao-terminada$/);
    await expect(page.locator("main").getByRole("status").filter({ hasText: MSG.signedOut })).toBeVisible();
    expect(await authCookies(page)).toEqual([]);

    await page.goBack();
    await expect(page.getByRole("button", { name: "Sair" })).toHaveCount(0);

    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login\?next=%2Fdashboard$/);
  });
});

test.describe("no public sign-up", () => {
  test("the app has no sign-up page or link", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("link", { name: /criar conta|registar|sign up/i })).toHaveCount(0);
    for (const path of ["/signup", "/registo", "/register"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/login/);
    }
  });

  test("Supabase Auth rejects sign-up requests", async ({ request }) => {
    const { apiUrl, publishableKey } = localStack();
    const response = await request.post(`${apiUrl}/auth/v1/signup`, {
      headers: { apikey: publishableKey, "content-type": "application/json" },
      data: { email: `intruso-${Date.now()}@test.local`, password: "Abcdefgh12345" },
    });
    expect(response.status()).toBe(422);
    expect((await response.json()).error_code).toBe("signup_disabled");
  });
});
