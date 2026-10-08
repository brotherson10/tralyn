import { expect, test, type Page } from "@playwright/test";
import { closeDb, createUser, db, signIn, uid } from "../db/helpers";
import { alert, flash, login, newPrefix, newUser } from "./support";

/** Products UI against LOCAL Supabase. Stock only changes via register_stock_movement. */

test.afterAll(closeDb);

interface Fixture {
  prefix: string;
  categoryId: string;
  categoryLabel: string;
  locationCode: string;
  supplierName: string;
}

async function seed(): Promise<Fixture> {
  const prefix = newPrefix();
  const categoryName = `Cat Produtos ${prefix}`;
  const { rows } = await db().query<{ id: string }>(
    `insert into public.categories (name, prefix) values ($1, $2) returning id`,
    [categoryName, prefix],
  );
  const locationCode = `LP-${prefix}`;
  const supplierName = `Fornecedor ${prefix}`;
  await db().query(`insert into public.locations (code) values ($1)`, [locationCode]);
  await db().query(`insert into public.suppliers (name) values ($1)`, [supplierName]);
  return { prefix, categoryId: rows[0].id, categoryLabel: `${categoryName} (${prefix})`, locationCode, supplierName };
}

async function seedProduct(fx: Fixture, code: string, minimum: number, model = `Modelo ${uid()}`) {
  const { rows } = await db().query<{ id: string }>(
    `insert into public.products (code, category_id, model, minimum_stock) values ($1, $2, $3, $4) returning id`,
    [code, fx.categoryId, model, minimum],
  );
  return rows[0].id;
}

/** Registers stock through the official RPC with a real admin session (never a direct balance write). */
async function receive(productId: string, quantity: number) {
  const client = await signIn(await createUser("admin"));
  const { error } = await client.rpc("register_stock_movement", { p_product_id: productId, p_type: "IN", p_quantity: quantity });
  if (error) throw new Error(error.message);
}

const select = (page: Page, label: string) => page.getByRole("combobox", { name: new RegExp(`^${label}`) });

test.describe("admin", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, await newUser("admin", "Admin Produtos"));
  });

  test("creates a product with stock 0, edits it and deactivates/reactivates it", async ({ page }) => {
    const fx = await seed();
    const code = `${fx.prefix}-001`;

    await page.goto("/produtos");
    await page.getByRole("link", { name: "Novo produto" }).click();
    await expect(page.getByText("O produto é criado com stock 0.")).toBeVisible();

    // Required fields, validated on the server.
    await page.getByRole("button", { name: "Criar produto" }).click();
    await expect(page.getByText("Indique o código.")).toBeVisible();
    await expect(page.getByText("Escolha a categoria.")).toBeVisible();
    // Model is optional now; brand OR model is required (message on both fields).
    await expect(page.getByText("Indique pelo menos a marca ou o modelo.", { exact: true })).toHaveCount(2);

    // No stock input exists anywhere in the form.
    await expect(page.getByLabel(/stock atual|saldo/i)).toHaveCount(0);

    // Code must match the category prefix.
    await page.getByLabel("Código").fill("ZZZ-001");
    await select(page, "Categoria").selectOption({ label: fx.categoryLabel });
    await page.getByLabel("Marca").fill("Northgrid");
    await page.getByLabel("Modelo / produto").fill("VT 10K");
    await page.getByRole("button", { name: "Criar produto" }).click();
    await expect(page.getByText(`O código deve começar pelo prefixo da categoria: ${fx.prefix}-`)).toBeVisible();
    await expect(page.getByLabel("Modelo / produto")).toHaveValue("VT 10K");

    await page.getByLabel("Código").fill(code.toLowerCase());
    await page.getByLabel("Especificação").fill("20 kW");
    await page.getByLabel("Stock mínimo").fill("2");
    await select(page, "Localização").selectOption({ label: fx.locationCode });
    await select(page, "Fornecedor padrão").selectOption({ label: fx.supplierName });
    await page.getByRole("button", { name: "Criar produto" }).click();

    await expect(flash(page)).toContainText("O stock começa em 0");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Northgrid VT 10K");
    await expect(page.getByText(`Código ${code}`)).toBeVisible();
    await expect(page.getByTestId("stock-balance")).toContainText("0");
    await expect(page.getByTestId("stock-status")).toHaveText("Sem stock");
    await expect(page.getByText("Última movimentação: nenhuma registada")).toBeVisible();

    // Edit.
    await page.getByLabel("Stock mínimo").fill("5");
    await page.getByRole("button", { name: "Guardar alterações" }).click();
    await expect(flash(page)).toHaveText("Alterações guardadas. O stock não foi alterado.");
    await expect(page.getByTestId("stock-summary")).toContainText("5");

    // Duplicate code.
    await page.goto("/produtos/novo");
    await page.getByLabel("Código").fill(code);
    await select(page, "Categoria").selectOption({ label: fx.categoryLabel });
    await page.getByLabel("Modelo / produto").fill("Outro");
    await page.getByRole("button", { name: "Criar produto" }).click();
    await expect(page.getByText("Já existe um produto com este código.")).toBeVisible();

    // Deactivate (with confirmation) and reactivate.
    await page.goto(`/produtos?q=${code}`);
    await page.getByRole("link", { name: code }).click();
    await page.getByRole("button", { name: "Desativar produto" }).click();
    await page.getByRole("button", { name: "Sim, desativar" }).click();
    await expect(page.getByRole("note")).toContainText("Não pode receber novas movimentações");
    await page.getByRole("button", { name: "Reativar produto" }).click();
    await page.getByRole("button", { name: "Sim, reativar" }).click();
    await expect(flash(page)).toContainText("Produto reativado");
    await expect(page.getByRole("note")).toHaveCount(0);
  });

  test("inactive relations: not offered for new products, kept and flagged on existing ones", async ({ page }) => {
    const fx = await seed();
    const id = await seedProduct(fx, `${fx.prefix}-010`, 1);
    await db().query(`update public.categories set active = false where id = $1`, [fx.categoryId]);

    await page.goto("/produtos/novo");
    const categoryOptions = await select(page, "Categoria").locator("option").allTextContents();
    expect(categoryOptions.some((text) => text.includes(fx.prefix))).toBe(false);

    await page.goto(`/produtos/${id}`);
    const category = select(page, "Categoria");
    await expect(category.locator("option:checked")).toHaveText(`${fx.categoryLabel} — inativa`);
    await expect(page.getByText("A categoria atual está inativa.")).toBeVisible();

    await page.getByLabel("Stock mínimo").fill("4");
    await page.getByRole("button", { name: "Guardar alterações" }).click();
    await expect(flash(page)).toHaveText("Alterações guardadas. O stock não foi alterado.");
    await expect(select(page, "Categoria").locator("option:checked")).toHaveText(`${fx.categoryLabel} — inativa`);
  });

  test("list: search, combined filters and statuses computed by the database", async ({ page }) => {
    const fx = await seed();
    const marker = `Lista${uid()}`;
    const empty = await seedProduct(fx, `${fx.prefix}-101`, 2, `${marker} vazio`);
    const low = await seedProduct(fx, `${fx.prefix}-102`, 2, `${marker} baixo`);
    const ok = await seedProduct(fx, `${fx.prefix}-103`, 2, `${marker} ok`);
    await receive(low, 2);
    await receive(ok, 9);

    await page.goto(`/produtos?q=${marker}`);
    await expect(page.getByText("3 produtos")).toBeVisible();
    await expect(page.getByRole("row", { name: new RegExp(`${fx.prefix}-101`) })).toContainText("Sem stock");
    await expect(page.getByRole("row", { name: new RegExp(`${fx.prefix}-102`) })).toContainText("Repor stock");
    await expect(page.getByRole("row", { name: new RegExp(`${fx.prefix}-103`) })).toContainText("OK");
    await expect(page.getByRole("row", { name: new RegExp(`${fx.prefix}-103`) })).toContainText("9");

    // Filters via the form (URL is the source of truth).
    await page.getByLabel("Stock", { exact: true }).selectOption("REORDER");
    await page.getByRole("button", { name: "Pesquisar" }).click();
    await expect(page).toHaveURL(/stock=REORDER/);
    await expect(page.getByText("1 produto", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `${fx.prefix}-102` })).toBeVisible();

    await page.goto(`/produtos?q=${marker}&categoria=${fx.categoryId}&localizacao=sem&stock=OUT_OF_STOCK&estado=ativos`);
    await expect(page.getByText("1 produto", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: `${fx.prefix}-101` })).toBeVisible();

    await page.goto(`/produtos?q=${marker}&stock=OK&estado=inativos`);
    await expect(page.getByText("Nenhum produto encontrado")).toBeVisible();
    expect(empty).toBeTruthy();
  });
});

for (const role of ["operator", "viewer"] as const) {
  test(`${role}: read-only products (stock visible, no management actions)`, async ({ page }) => {
    const fx = await seed();
    const code = `${fx.prefix}-201`;
    const id = await seedProduct(fx, code, 1);
    await receive(id, 3);
    await login(page, await newUser(role, `Leitura produtos ${role}`));

    await page.goto(`/produtos?q=${code}`);
    await expect(page.getByRole("link", { name: "Novo produto" })).toHaveCount(0);
    await page.getByRole("link", { name: code }).click();

    await expect(page.getByTestId("stock-balance")).toContainText("3");
    await expect(page.getByTestId("stock-status")).toHaveText("OK");
    await expect(page.getByRole("button", { name: "Guardar alterações" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Desativar produto|Reativar produto/ })).toHaveCount(0);
    await expect(page.locator("main input, main select, main textarea")).toHaveCount(0);
    await expect(page.locator("dl")).toContainText(fx.categoryLabel);

    await page.goto("/produtos/novo");
    await expect(page).toHaveURL(/\/sem-permissao$/);
  });
}

test("mobile: product list shows code, product, stock and status", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fx = await seed();
  const code = `${fx.prefix}-301`;
  await seedProduct(fx, code, 0, "Produto Mobile");
  await login(page, await newUser("viewer", "Consulta Produtos Mobile"));
  await page.goto(`/produtos?q=${code}`);
  const row = page.getByRole("row", { name: new RegExp(code) });
  await expect(row).toContainText("Produto Mobile");
  await expect(row).toContainText("Sem stock");
  await expect(alert(page)).toHaveCount(0);
});
