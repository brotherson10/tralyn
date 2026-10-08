import { expect, test, type Page } from "@playwright/test";
import { createProduct, db, insertMovementAsSuperuser } from "../db/helpers";
import { login, newUser } from "./support";

/**
 * No authenticated page may overflow the viewport horizontally at phone,
 * tablet and desktop widths. A table that scrolls inside its own container
 * (TableShell, overflow-x-auto) is fine; the document itself must fit.
 *
 * Diagnostic screenshots go to the Playwright output folder (test-results/,
 * git-ignored). They are evidence only, not snapshot assertions.
 */

const WIDTHS = [
  { name: "mobile", width: 375, height: 812 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 900 },
] as const;

const ROUTES = [
  "/dashboard",
  "/produtos",
  "/produtos/novo",
  "/movimentacoes",
  "/movimentacoes/nova",
  "/categorias",
  "/localizacoes",
  "/fornecedores",
  "/projetos",
] as const;

/** Screenshots kept as evidence (route, width). */
const SCREENSHOTS = new Set([
  "mobile:/dashboard",
  "mobile:/produtos",
  "mobile:/movimentacoes",
  "mobile:/movimentacoes/nova",
  "tablet:/dashboard",
  "tablet:/produtos",
  "tablet:/movimentacoes",
  "desktop:/dashboard",
  "desktop:/produtos",
  "desktop:/movimentacoes/nova",
  "desktop:detalhe-produto",
  "mobile:detalhe-produto",
  "mobile:detalhe-produto-vazio",
  "desktop:detalhe-produto-vazio",
]);

interface OverflowReport {
  viewport: number;
  documentWidth: number;
  offenders: string[];
}

/** Document overflow + the elements that stick out (ignoring content inside its own scroll/clip container). */
async function horizontalOverflow(page: Page): Promise<OverflowReport> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const viewport = root.clientWidth;
    const documentWidth = Math.max(root.scrollWidth, document.body.scrollWidth);
    const offenders: string[] = [];
    if (documentWidth > viewport) {
      const contained = (el: Element) => {
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(p).overflowX)) return true;
        }
        return false;
      };
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.right <= viewport + 1 || contained(el)) continue;
        const id = el.id ? `#${el.id}` : "";
        const cls = typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).slice(0, 4).join(".")}` : "";
        offenders.push(`${el.tagName.toLowerCase()}${id}${cls} (right=${Math.round(rect.right)})`);
        if (offenders.length >= 8) break;
      }
    }
    return { viewport, documentWidth, offenders };
  });
}

async function expectNoOverflow(page: Page, label: string) {
  const report = await horizontalOverflow(page);
  expect(report.documentWidth, `${label}: página com overflow horizontal → ${report.offenders.join(" | ")}`).toBeLessThanOrEqual(report.viewport);
}

let detailPaths: string[] = [];

test.beforeAll(async () => {
  // Stable detail fixtures: one product with one movement (local DB only).
  const author = await newUser("admin", "Responsivo Autor");
  const product = await createProduct({ minimumStock: 2 });
  await insertMovementAsSuperuser(product.id, "OPENING_BALANCE", 5, author.id);
  const movement = await db().query<{ id: string }>(`select id from public.stock_movements where product_id = $1`, [product.id]);
  const empty = await createProduct({ minimumStock: 1 }); // no movements: compact EmptyState
  detailPaths = [`/produtos/${product.id}`, `/movimentacoes/${movement.rows[0].id}`, `/produtos/${empty.id}`];
});

for (const size of WIDTHS) {
  test.describe(`${size.name} ${size.width}px`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });

    test("no authenticated page overflows horizontally", async ({ page }, testInfo) => {
      await login(page, await newUser("admin", `Responsivo ${size.width}`));
      for (const route of [...ROUTES, ...detailPaths]) {
        await page.goto(route);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expectNoOverflow(page, `${size.width}px ${route}`);
        const key = route === detailPaths[0] ? "detalhe-produto" : route === detailPaths[2] ? "detalhe-produto-vazio" : route;
        if (SCREENSHOTS.has(`${size.name}:${key}`)) {
          const file = key.startsWith("detalhe-") ? `_${key}` : route.replaceAll("/", "_");
          await page.screenshot({ path: testInfo.outputPath(`${size.width}${file}.png`), fullPage: true });
        }
      }
    });
  });
}

test.describe("overflow detector self-check", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("flags a page-level overflow and ignores a wide table inside its scroll container", async ({ page }) => {
    await login(page, await newUser("admin", "Responsivo Detetor"));
    await page.evaluate(() => {
      const scroller = document.createElement("div");
      scroller.className = "overflow-x-auto";
      scroller.innerHTML = '<div style="width:2000px;height:10px"></div>';
      document.querySelector("main")!.append(scroller);
    });
    expect((await horizontalOverflow(page)).documentWidth).toBeLessThanOrEqual(375);

    await page.evaluate(() => {
      const wide = document.createElement("div");
      wide.id = "too-wide";
      wide.style.width = "900px";
      wide.style.height = "10px";
      document.querySelector("main")!.append(wide);
    });
    const report = await horizontalOverflow(page);
    expect(report.documentWidth).toBeGreaterThan(report.viewport);
    expect(report.offenders.join(" ")).toContain("div#too-wide");
  });
});

test.describe("mobile drawer evidence", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("open drawer does not overflow", async ({ page }, testInfo) => {
    await login(page, await newUser("admin", "Responsivo Drawer"));
    await page.getByRole("button", { name: "Abrir menu" }).click();
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeVisible();
    await expectNoOverflow(page, "375px drawer aberto");
    await page.screenshot({ path: testInfo.outputPath("375_drawer_aberto.png") });
  });
});
