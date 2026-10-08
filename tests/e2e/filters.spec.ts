import { expect, test, type Page } from "@playwright/test";
import { login, newUser } from "./support";

/**
 * SearchBar on small and large screens: the main search is always visible;
 * secondary filters collapse into a native <details> ("Filtros") on mobile,
 * open by themselves when a filter is active, and are always shown on desktop.
 * Query parameters keep working exactly as before.
 */

const summary = (page: Page) => page.locator("details.search-filters > summary");
const stockFilter = (page: Page) => page.getByLabel("Stock", { exact: true });

test.describe("mobile 375px", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test.beforeEach(async ({ page }) => {
    await login(page, await newUser("admin", "Filtros Mobile"));
  });

  test("main search visible, secondary filters collapsed until opened", async ({ page }, testInfo) => {
    await page.goto("/produtos");
    await expect(page.getByRole("searchbox", { name: "Pesquisar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pesquisar" })).toBeVisible();
    await expect(summary(page)).toHaveText(/^Filtros$/);
    await expect(stockFilter(page)).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("375_produtos_filtros_fechados.png") });

    await summary(page).click();
    await expect(stockFilter(page)).toBeVisible();
    await expect(page.getByLabel("Categoria")).toBeVisible();
  });

  test("an active filter opens the block and is counted; search and filters submit together", async ({ page }, testInfo) => {
    await page.goto("/produtos");
    await page.getByRole("searchbox", { name: "Pesquisar" }).fill("TST");
    await summary(page).click();
    await stockFilter(page).selectOption("REORDER");
    await page.getByRole("button", { name: "Pesquisar" }).click();

    await expect(page).toHaveURL(/\/produtos\?.*q=TST/);
    await expect(page).toHaveURL(/stock=REORDER/);
    await expect(page.locator("details.search-filters")).toHaveAttribute("open", "");
    await expect(summary(page)).toHaveText(/Filtros\s*\(1 ativo\)/);
    await expect(stockFilter(page)).toHaveValue("REORDER");
    await expect(page.getByRole("searchbox", { name: "Pesquisar" })).toHaveValue("TST");
    await page.screenshot({ path: testInfo.outputPath("375_produtos_filtro_ativo.png") });
  });

  test("closing the block keeps its filters in the next search (no criteria lost)", async ({ page }) => {
    await page.goto("/produtos?stock=OK&estado=ativos");
    await expect(summary(page)).toHaveText(/\(2 ativos\)/);
    await summary(page).click(); // collapse
    await expect(stockFilter(page)).toBeHidden();
    await page.getByRole("button", { name: "Pesquisar" }).click();
    await expect(page).toHaveURL(/stock=OK/);
    await expect(page).toHaveURL(/estado=ativos/);
  });

  test("movement history: a type filter from the URL opens the block", async ({ page }) => {
    await page.goto("/movimentacoes?tipo=IN");
    await expect(page.locator("details.search-filters")).toHaveAttribute("open", "");
    await expect(summary(page)).toHaveText(/\(1 ativo\)/);
    await expect(page.getByLabel("Tipo")).toHaveValue("IN");
  });

  test("Limpar removes every criterion", async ({ page }) => {
    await page.goto("/categorias?q=x&estado=ativas");
    await page.getByRole("link", { name: "Limpar" }).click();
    await expect(page).toHaveURL(/\/categorias$/);
    await expect(summary(page)).toHaveText(/^Filtros$/);
  });
});

test.describe("desktop 1280px", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("filters are shown without opening anything; no summary", async ({ page }, testInfo) => {
    await login(page, await newUser("admin", "Filtros Desktop"));
    await page.goto("/produtos");
    await expect(stockFilter(page)).toBeVisible();
    await expect(page.getByLabel("Categoria")).toBeVisible();
    await expect(summary(page)).toBeHidden();
    await page.screenshot({ path: testInfo.outputPath("1280_produtos_filtros.png") });
  });
});
