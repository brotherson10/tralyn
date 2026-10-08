import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, uid } from "../db/helpers";
import { alert, login, newPrefix, newUser } from "./support";

/** Stock movements UI against LOCAL Supabase. Every balance change goes through the RPC. */

test.afterAll(closeDb);

async function seedProduct(opts: { minimum?: number; active?: boolean } = {}) {
  const prefix = newPrefix();
  const { rows: cat } = await db().query<{ id: string }>(
    `insert into public.categories (name, prefix) values ($1, $2) returning id`,
    [`Cat Mov ${prefix}`, prefix],
  );
  const code = `${prefix}-001`;
  const model = `Modelo ${uid()}`;
  const { rows } = await db().query<{ id: string }>(
    `insert into public.products (code, category_id, brand, model, minimum_stock, active) values ($1, $2, 'Marca', $3, $4, $5) returning id`,
    [code, cat[0].id, model, opts.minimum ?? 2, opts.active ?? true],
  );
  return { id: rows[0].id, code, label: `${code} — Marca ${model}` };
}

async function seedProject(status: "active" | "completed" | "cancelled") {
  const name = `Obra ${status} ${uid()}`;
  const { rows } = await db().query<{ id: string }>(
    `insert into public.projects (name, status) values ($1, $2) returning id`,
    [name, status],
  );
  return { id: rows[0].id, name };
}

/** The +/− symbol is aria-hidden, so the accessible name starts with the label. */
const typeRadio = (page: Page, label: string) =>
  page.getByRole("radio", { name: new RegExp(`^${label.replace("+", "\\+")} `) });

async function registerMovement(
  page: Page,
  productId: string,
  type: string,
  quantity: string,
  extra: { project?: string; reference?: string; notes?: string } = {},
) {
  await page.goto(`/movimentacoes/nova?produto=${productId}`);
  await typeRadio(page, type).check();
  await page.getByLabel(/^Quantidade/).fill(quantity);
  if (extra.project) await page.getByRole("combobox", { name: /^Projeto/ }).selectOption({ label: extra.project });
  if (extra.reference) await page.getByLabel(/^Referência/).fill(extra.reference);
  if (extra.notes) await page.getByLabel(/^Observações/).fill(extra.notes);
  await page.getByRole("button", { name: /^Registar/ }).click();
}

test.describe("admin", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, await newUser("admin", "Admin Movimentos"));
  });

  test("IN → OUT → insufficient OUT → adjustments, with statuses and feedback from the database", async ({ page }) => {
    const product = await seedProduct({ minimum: 2 });
    const project = await seedProject("active");
    const closed = await seedProject("completed");

    await page.goto(`/movimentacoes/nova?produto=${product.id}`);
    // Operational types only: no "Saldo inicial".
    await expect(page.getByRole("radio")).toHaveCount(4);
    await expect(page.locator("form").getByText("Saldo inicial")).toHaveCount(0);
    // Only active projects are offered.
    const projects = await page.getByRole("combobox", { name: /^Projeto/ }).locator("option").allTextContents();
    expect(projects).toContain(project.name);
    expect(projects).not.toContain(closed.name);
    // Product context (information only, no balance input).
    await expect(page.getByTestId("context-balance")).toHaveText("0 un");
    await expect(page.getByTestId("product-context")).toContainText("Sem stock");
    await expect(page.getByLabel(/stock atual/i)).toHaveCount(0);

    // IN 10
    await registerMovement(page, product.id, "Entrada", "10");
    await expect(page.getByRole("status").first()).toContainText(`Entrada de 10 un registada para ${product.code}.`);
    await expect(page.getByTestId("balance-after")).toHaveText("10 un");
    await expect(page.getByRole("status").first()).toContainText("OK");

    // OUT 8 with project and reference → 2 (Repor stock)
    await registerMovement(page, product.id, "Saída", "8", { project: project.name, reference: "GR-2026/001" });
    await expect(page.getByTestId("balance-after")).toHaveText("2 un");
    await expect(page.getByRole("status").first()).toContainText("Repor stock");

    // OUT 8 → refused by the database; the preview warns before submitting.
    await page.goto(`/movimentacoes/nova?produto=${product.id}`);
    await typeRadio(page, "Saída").check();
    await page.getByLabel(/^Quantidade/).fill("8");
    await expect(page.getByText("A base de dados vai recusar este registo.")).toBeVisible();
    await page.getByRole("button", { name: /^Registar/ }).click();
    await expect(alert(page).first()).toHaveText("Stock insuficiente. Disponível: 2 un.");
    await expect(page.getByLabel(/^Quantidade/)).toHaveValue("8");

    // Adjustments require a reason.
    await registerMovement(page, product.id, "Ajuste +", "3");
    await expect(page.getByText(/explique o motivo nas observações/)).toBeVisible();
    await page.getByLabel(/^Observações/).fill("Contagem física encontrou 3 unidades adicionais.");
    await page.getByRole("button", { name: /^Registar/ }).click();
    await expect(page.getByTestId("balance-after")).toHaveText("5 un");
    await expect(page.getByRole("status").first()).toContainText("Ajuste + de 3 un registado");

    await registerMovement(page, product.id, "Ajuste -", "5", { notes: "Unidades danificadas na conferência." });
    await expect(page.getByTestId("balance-after")).toHaveText("0 un");
    await expect(page.getByRole("status").first()).toContainText("Sem stock");

    // History for the product, newest first, with signed quantities.
    await page.goto(`/movimentacoes?produto=${product.id}`);
    await expect(page.getByText("4 movimentações")).toBeVisible();
    const rows = page.locator("tbody tr");
    await expect(rows.nth(0)).toContainText("Ajuste -");
    await expect(rows.nth(0)).toContainText("−5");
    await expect(rows.nth(3)).toContainText("Entrada");
    await expect(rows.nth(3)).toContainText("+10");
    await expect(rows.nth(2)).toContainText(project.name);

    // Read-only detail: responsible user from the session, no edit/delete.
    await rows.nth(2).getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText(`Saída · ${product.code}`);
    await expect(page.locator("dl")).toContainText("Admin Movimentos");
    await expect(page.locator("dl")).toContainText("GR-2026/001");
    await expect(page.getByRole("button", { name: /editar|apagar|eliminar|guardar/i })).toHaveCount(0);
    await expect(page.locator("main input, main textarea, main select")).toHaveCount(0);
    await expect(page.getByRole("note")).toContainText("Movimentações são imutáveis");

    // Product page shows the same stock and recent history.
    await page.goto(`/produtos/${product.id}`);
    await expect(page.getByTestId("stock-balance")).toContainText("0");
    await expect(page.locator("tbody tr")).toHaveCount(4);
  });

  test("rejects zero and negative quantities", async ({ page }) => {
    const product = await seedProduct();
    for (const quantity of ["0", "-5"]) {
      await registerMovement(page, product.id, "Entrada", quantity);
      await expect(page.getByText("A quantidade tem de ser maior que zero.", { exact: false })).toBeVisible();
    }
    await page.goto(`/movimentacoes?produto=${product.id}`);
    await expect(page.getByText("Nenhuma movimentação encontrada")).toBeVisible();
  });

  test("inactive products are not offered; the submit button blocks double submission", async ({ page }) => {
    const inactive = await seedProduct({ active: false });
    const active = await seedProduct();
    // Server-side product search; inactive products never appear.
    await page.goto("/movimentacoes/nova");
    await page.getByLabel("Encontrar produto").fill(inactive.code);
    await page.getByRole("button", { name: "Procurar" }).click();
    await expect(page.getByText("Nenhum produto ativo corresponde à pesquisa.")).toBeVisible();
    await page.getByLabel("Encontrar produto").fill(active.code);
    await page.getByRole("button", { name: "Procurar" }).click();
    await expect(page).toHaveURL(new RegExp(`busca=${active.code}`));
    await expect(page.getByText("1 produto ativo", { exact: false })).toBeVisible();
    const options = await page.getByRole("combobox", { name: /^Produto/ }).locator("option").allTextContents();
    expect(options.some((text) => text.startsWith(inactive.code))).toBe(false);
    expect(options.some((text) => text.startsWith(active.code))).toBe(true);

    await page.goto(`/movimentacoes/nova?produto=${active.id}`);
    await page.route("**/movimentacoes/nova*", async (route) => {
      if (route.request().method() === "POST") await new Promise((resolve) => setTimeout(resolve, 1200));
      await route.continue();
    });
    await typeRadio(page, "Entrada").check();
    await page.getByLabel(/^Quantidade/).fill("1");
    await page.getByRole("button", { name: /^Registar/ }).click();
    await expect(page.getByRole("button", { name: "A registar…" })).toBeDisabled();
    await expect(page.getByTestId("balance-after")).toHaveText("1 un");
  });

  test("history filters work from the URL and the form", async ({ page }) => {
    const product = await seedProduct();
    await registerMovement(page, product.id, "Entrada", "4");
    await registerMovement(page, product.id, "Saída", "1");

    await page.goto(`/movimentacoes?q=${product.code}`);
    await expect(page.getByText("2 movimentações")).toBeVisible();
    await page.getByLabel("Tipo", { exact: true }).selectOption("OUT");
    await page.getByRole("button", { name: "Pesquisar" }).click();
    await expect(page).toHaveURL(/tipo=OUT/);
    await expect(page.getByText("1 movimentação", { exact: true })).toBeVisible();

    await page.goto(`/movimentacoes?q=${product.code}&de=2000-01-01&ate=2000-01-31`);
    await expect(page.getByText("Nenhuma movimentação encontrada")).toBeVisible();
  });
});

test("operator: only Entrada and Saída are offered", async ({ page }) => {
  const product = await seedProduct();
  await login(page, await newUser("operator", "Operador Movimentos"));
  await page.goto(`/movimentacoes/nova?produto=${product.id}`);
  await expect(page.getByRole("radio")).toHaveCount(2);
  await expect(page.getByText("Ajustes de inventário")).toHaveCount(0);
  await registerMovement(page, product.id, "Entrada", "3");
  await expect(page.getByTestId("balance-after")).toHaveText("3 un");
  await registerMovement(page, product.id, "Saída", "1");
  await expect(page.getByTestId("balance-after")).toHaveText("2 un");
});

test("viewer: history only, no registration", async ({ page }) => {
  await login(page, await newUser("viewer", "Consulta Movimentos"));
  await page.goto("/movimentacoes");
  await expect(page.getByRole("link", { name: "Nova movimentação" })).toHaveCount(0);
  await page.goto("/movimentacoes/nova");
  await expect(page).toHaveURL(/\/sem-permissao$/);
});

test("mobile: register an entry on a small screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const product = await seedProduct();
  await login(page, await newUser("operator", "Operador Mobile"));
  await registerMovement(page, product.id, "Entrada", "7");
  await expect(page.getByTestId("balance-after")).toHaveText("7 un");
  await page.goto(`/movimentacoes?produto=${product.id}`);
  await expect(page.locator("tbody tr").first()).toContainText("+7");
});
