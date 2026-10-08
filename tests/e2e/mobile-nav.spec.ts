import { expect, test, type Page } from "@playwright/test";
import { login, newUser } from "./support";

/**
 * Mobile navigation drawer: focus management, local focus trap, the four ways
 * to close it, and the page scroll lock. Assertions wait on state (no fixed
 * sleeps).
 */

test.use({ viewport: { width: 375, height: 812 } });

const menuButton = (page: Page) => page.getByRole("button", { name: "Abrir menu" });
const drawer = (page: Page) => page.getByRole("dialog", { name: "Menu" });
const closeButton = (page: Page) => drawer(page).getByRole("button", { name: "Fechar menu" });

const focusInsideDrawer = (page: Page) =>
  page.evaluate(() => Boolean(document.getElementById("menu-movel")?.contains(document.activeElement)));
const bodyOverflow = (page: Page) => page.evaluate(() => document.body.style.overflow);

async function openMenu(page: Page) {
  await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();
  await expect(menuButton(page)).toHaveAttribute("aria-expanded", "true");
}

async function expectClosed(page: Page) {
  await expect(drawer(page)).toHaveCount(0);
  await expect(menuButton(page)).toHaveAttribute("aria-expanded", "false");
  expect(await bodyOverflow(page)).toBe("");
}

test.beforeEach(async ({ page }) => {
  await login(page, await newUser("admin", "Menu Mobile"));
});

test("menu button is wired to the drawer (aria-controls, aria-expanded)", async ({ page }) => {
  await expect(menuButton(page)).toHaveAttribute("aria-controls", "menu-movel");
  await expect(page.locator("#menu-movel")).toBeHidden();
  await openMenu(page);
});

test("opening moves focus into the drawer, onto the visible close button", async ({ page }) => {
  await openMenu(page);
  await expect(closeButton(page)).toBeVisible();
  await expect(closeButton(page)).toBeFocused();
});

test("Tab and Shift+Tab stay inside the open drawer (focus trap)", async ({ page }) => {
  await openMenu(page);
  const count = await page.locator("#menu-movel").evaluate(
    (el) => el.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])').length,
  );
  for (let i = 0; i < count + 2; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDrawer(page), `Tab #${i + 1}`).toBe(true);
  }
  // Wrap-around at both ends, whatever the order of the focusable elements.
  const focusEdge = (edge: "first" | "last") =>
    page.locator("#menu-movel").evaluate((el, which) => {
      const all = el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
      (which === "first" ? all[0] : all[all.length - 1]).focus();
    }, edge);
  const activeIsEdge = (edge: "first" | "last") =>
    page.locator("#menu-movel").evaluate((el, which) => {
      const all = el.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
      return document.activeElement === (which === "first" ? all[0] : all[all.length - 1]);
    }, edge);

  await focusEdge("first");
  await page.keyboard.press("Shift+Tab");
  expect(await activeIsEdge("last")).toBe(true);
  await expect(drawer(page).getByRole("button", { name: "Sair" })).toBeFocused();
  await page.keyboard.press("Tab");
  expect(await activeIsEdge("first")).toBe(true);
});

test("Escape closes and returns focus to the menu button", async ({ page }) => {
  await openMenu(page);
  await page.keyboard.press("Escape");
  await expectClosed(page);
  await expect(menuButton(page)).toBeFocused();
});

test("the close button closes and returns focus to the menu button", async ({ page }) => {
  await openMenu(page);
  await closeButton(page).click();
  await expectClosed(page);
  await expect(menuButton(page)).toBeFocused();
});

test("a click on the backdrop closes the drawer", async ({ page }) => {
  await openMenu(page);
  // The drawer covers the left side; the backdrop stays visible on the right.
  await page.getByTestId("menu-backdrop").click({ position: { x: 360, y: 400 } });
  await expectClosed(page);
});

test("following a link closes the drawer and navigates", async ({ page }) => {
  await openMenu(page);
  await drawer(page).getByRole("link", { name: "Produtos" }).click();
  await expect(page).toHaveURL(/\/produtos$/);
  await expectClosed(page);
});

test("the page does not scroll while the drawer is open; scrolling is restored on close", async ({ page }) => {
  await page.goto("/movimentacoes");
  await expect(page.getByRole("heading", { level: 1, name: "Movimentações" })).toBeVisible();
  // Make sure the page is taller than the viewport, independently of the data.
  await page.evaluate(() => {
    const spacer = document.createElement("div");
    spacer.style.height = "3000px";
    document.querySelector("main")!.append(spacer);
  });

  await openMenu(page);
  expect(await bodyOverflow(page)).toBe("hidden");
  await page.mouse.move(360, 400); // over the backdrop
  await page.mouse.wheel(0, 800);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);

  await page.keyboard.press("Escape");
  await expectClosed(page);
  await page.mouse.wheel(0, 800);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});

test("closed drawer: nothing in it is focusable and the trap is inactive", async ({ page }) => {
  await expect(page.locator("#menu-movel")).toBeHidden();
  for (let i = 0; i < 6; i += 1) {
    await page.keyboard.press("Tab");
    expect(await focusInsideDrawer(page)).toBe(false);
  }
});

test("no duplicate ids and every visible button has an accessible name (open and closed)", async ({ page }) => {
  const audit = () =>
    page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll("[id]")).map((el) => el.id);
      const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
      const unnamed = Array.from(document.querySelectorAll("button"))
        .filter((b) => b.offsetParent !== null)
        .filter((b) => !(b.getAttribute("aria-label") || b.textContent?.trim()))
        .map((b) => b.outerHTML.slice(0, 80));
      return { duplicates, unnamed };
    });
  expect(await audit()).toEqual({ duplicates: [], unnamed: [] });
  await openMenu(page);
  expect(await audit()).toEqual({ duplicates: [], unnamed: [] });
});
