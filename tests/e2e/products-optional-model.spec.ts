import { expect, test, type Page } from "@playwright/test";
import { closeDb, db, uid } from "../db/helpers";
import { alert, flash, login, newPrefix, newUser } from "./support";

/** Products whose model is unknown (model = NULL), against LOCAL Supabase. */

test.afterAll(closeDb);

async function seedCategory() {
  const prefix = newPrefix();
  const name = `Cat Sem Modelo ${prefix}`;
  await db().query(`insert into public.categories (name, prefix) values ($1, $2)`, [name, prefix]);
  return { prefix, label: `${name} (${prefix})` };
}

const select = (page: Page, label: string) => page.getByRole("combobox", { name: new RegExp(`^${label}`) });

async function fillNewProduct(page: Page, code: string, categoryLabel: string, brand: string, model: string) {
  await page.goto("/produtos/novo");
  await page.getByLabel("Código").fill(code);
  await select(page, "Categoria").selectOption({ label: categoryLabel });
  await page.getByLabel("Marca").fill(brand);
  await page.getByLabel(/^Modelo \/ produto/).fill(model);
  await page.getByRole("button", { name: "Criar produto" }).click();
}

test("admin: brand-only product, model-only product, and the brand-or-model rule", async ({ page }) => {
  const category = await seedCategory();
  const brand = `Voltaris${uid()}`;
  await login(page, await newUser("admin", "Admin Sem Modelo"));

  // The model field is optional and explains when to leave it empty.
  await page.goto("/produtos/novo");
  await expect(page.getByText("Deixe vazio apenas se o modelo for desconhecido.", { exact: false })).toBeVisible();

  // Neither brand nor model → message on both fields.
  await fillNewProduct(page, `${category.prefix}-001`, category.label, "", "");
  await expect(alert(page).first()).toHaveText("Verifique os campos assinalados.");
  await expect(page.getByText("Indique pelo menos a marca ou o modelo.", { exact: true })).toHaveCount(2);

  // Brand only.
  await fillNewProduct(page, `${category.prefix}-001`, category.label, brand, "   ");
  await expect(flash(page)).toContainText("Produto criado");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(brand);
  await expect(page.getByText(`Código ${category.prefix}-001`)).toBeVisible();
  await expect(page.getByRole("note").filter({ hasText: "o modelo deste produto não está indicado" })).toBeVisible();
  await expect(page.getByLabel(/^Modelo \/ produto/)).toHaveValue("");
  await expect(page.locator("main")).not.toContainText(/null|undefined|N\/A|Modelo a confirmar/);

  // Listing shows the brand and a discreet "Modelo não indicado".
  await page.goto(`/produtos?q=${category.prefix}-001`);
  const row = page.getByRole("row", { name: new RegExp(`${category.prefix}-001`) });
  await expect(row).toContainText(brand);
  await expect(row).toContainText("Modelo não indicado");

  // Model only.
  await fillNewProduct(page, `${category.prefix}-002`, category.label, "", "Pulsar Plus");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Pulsar Plus");

  // Editing: removing the model keeps working while the brand stays…
  await fillNewProduct(page, `${category.prefix}-003`, category.label, "Northgrid", "20K");
  await page.getByLabel(/^Modelo \/ produto/).fill("");
  await page.getByRole("button", { name: "Guardar alterações" }).click();
  await expect(flash(page)).toContainText("Alterações guardadas");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Northgrid");
  // …but brand and model cannot both be removed.
  await page.getByLabel("Marca").fill("");
  await page.getByRole("button", { name: "Guardar alterações" }).click();
  await expect(page.getByText("Indique pelo menos a marca ou o modelo.", { exact: true })).toHaveCount(2);
});

test("product without model in movements, history and read-only detail", async ({ page }) => {
  const category = await seedCategory();
  const brand = `Gridora${uid()}`;
  const code = `${category.prefix}-010`;
  await db().query(
    `insert into public.products (code, category_id, brand, model, minimum_stock)
     select $1, id, $2, null, 1 from public.categories where prefix = $3`,
    [code, brand, category.prefix],
  );

  await login(page, await newUser("operator", "Operador Sem Modelo"));

  // Movement form: label "CODE — Brand".
  await page.goto(`/movimentacoes/nova?busca=${code}`);
  const option = select(page, "Produto").locator("option", { hasText: code });
  await expect(option).toHaveText(`${code} — ${brand}`);
  await select(page, "Produto").selectOption({ label: `${code} — ${brand}` });
  await page.getByRole("radio", { name: /^Entrada / }).check();
  await page.getByLabel(/^Quantidade/).fill("3");
  await page.getByRole("button", { name: /^Registar/ }).click();
  await expect(page.getByTestId("balance-after")).toHaveText("3 un");

  // History shows the product label.
  await page.goto(`/movimentacoes?q=${code}`);
  await expect(page.locator("tbody tr").first()).toContainText(code);
  await expect(page.locator("tbody tr").first()).toContainText(brand);

  // Read-only detail: "Não indicado".
  await page.goto(`/produtos?q=${code}`);
  await page.getByRole("link", { name: code }).click();
  await expect(page.locator("dl")).toContainText("Não indicado");
  await expect(page.getByTestId("stock-balance")).toContainText("3");
  await expect(page.locator("main")).not.toContainText(/null|undefined|N\/A/);
});
