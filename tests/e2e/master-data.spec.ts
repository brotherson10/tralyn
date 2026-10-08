import { expect, test } from "@playwright/test";
import { closeDb, uid } from "../db/helpers";
import { alert, flash, login, newPrefix, newUser, seedMasterData } from "./support";

/** Master data UI (categories, locations, suppliers, projects) against LOCAL Supabase. */

test.afterAll(closeDb);

test.describe("admin", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, await newUser("admin", "Admin Cadastros"));
  });

  test("categories: create, validate, detect duplicates, edit, deactivate with confirmation, search", async ({ page }) => {
    const name = `Categoria E2E ${uid()}`;
    const prefix = newPrefix();

    await page.goto("/categorias");
    await page.getByRole("link", { name: "Nova categoria" }).click();
    await expect(page).toHaveURL(/\/categorias\/nova$/);

    // Server-side validation of required fields.
    await page.getByRole("button", { name: "Criar categoria" }).click();
    await expect(alert(page).first()).toHaveText("Verifique os campos assinalados.");
    await expect(page.getByText("Indique o nome.")).toBeVisible();
    await expect(page.getByText("Indique o prefixo.")).toBeVisible();

    // Lowercase prefix is normalized to uppercase by the server.
    await page.getByLabel("Nome").fill(name);
    await page.getByLabel("Prefixo").fill(prefix.toLowerCase());
    await page.getByLabel("Descrição").fill("Criada pelo teste E2E");
    await page.getByRole("button", { name: "Criar categoria" }).click();
    await expect(page).toHaveURL(/\/categorias\?sucesso=criada$/);
    await expect(flash(page)).toHaveText("Categoria criada com sucesso.");

    // Search.
    await page.getByLabel("Pesquisar").fill(name);
    await page.getByRole("button", { name: "Pesquisar" }).click();
    await expect(page.getByText("1 categoria")).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(name) });
    await expect(row).toContainText(prefix);
    await expect(row).toContainText("Ativa");

    // Duplicate prefix is reported on the field; typed values are kept.
    await page.goto("/categorias/nova");
    await page.getByLabel("Nome").fill(`${name} bis`);
    await page.getByLabel("Prefixo").fill(prefix);
    await page.getByRole("button", { name: "Criar categoria" }).click();
    await expect(page.getByText("Este prefixo já está a ser usado por outra categoria.")).toBeVisible();
    await expect(page.getByLabel("Nome")).toHaveValue(`${name} bis`);
    await expect(page.getByLabel("Prefixo")).toHaveAttribute("aria-invalid", "true");

    // Edit.
    await page.goto(`/categorias?q=${encodeURIComponent(name)}`);
    await page.getByRole("link", { name }).click();
    await page.getByLabel("Nome").fill(`${name} editada`);
    await page.getByRole("button", { name: "Guardar alterações" }).click();
    await expect(flash(page)).toHaveText("Alterações guardadas.");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${name} editada`);

    // Deactivate: first click only asks for confirmation; cancel keeps it active.
    await page.getByRole("button", { name: "Desativar categoria" }).click();
    await expect(page.getByText(`Desativar a categoria "${name} editada"?`)).toBeVisible();
    await page.getByRole("button", { name: "Cancelar" }).last().click();
    await expect(page.getByText("Ativa", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Desativar categoria" }).click();
    await page.getByRole("button", { name: "Sim, desativar" }).click();
    await expect(flash(page)).toContainText("Categoria desativada.");
    await expect(page.getByText("Inativa", { exact: true }).first()).toBeVisible();

    // Filter by state.
    await page.goto(`/categorias?q=${encodeURIComponent(name)}&estado=inativos`);
    await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("Inativa");
    await page.goto(`/categorias?q=${encodeURIComponent(name)}&estado=ativos`);
    await expect(page.getByText("Nenhuma categoria encontrada")).toBeVisible();

    // Reactivate.
    await page.goto(`/categorias?q=${encodeURIComponent(name)}`);
    await page.getByRole("link", { name: `${name} editada` }).click();
    await page.getByRole("button", { name: "Reativar categoria" }).click();
    await page.getByRole("button", { name: "Sim, reativar" }).click();
    await expect(flash(page)).toHaveText("Categoria ativada.");
  });

  test("locations: create and edit", async ({ page }) => {
    const code = `E2E-${uid()}`;
    await page.goto("/localizacoes/nova");
    await page.getByLabel("Código").fill(code);
    await page.getByLabel("Zona / estante").fill("A");
    await page.getByLabel("Prateleira").fill("01");
    await page.getByLabel("Posição").fill("02");
    await page.getByRole("button", { name: "Criar localização" }).click();
    await expect(flash(page)).toHaveText("Localização criada com sucesso.");

    await page.goto(`/localizacoes?q=${code}`);
    await page.getByRole("link", { name: code }).click();
    await page.getByLabel("Descrição").fill("Estante junto à porta");
    await page.getByRole("button", { name: "Guardar alterações" }).click();
    await expect(flash(page)).toHaveText("Alterações guardadas.");
    await expect(page.getByText("Estante junto à porta").first()).toBeVisible();

    // Duplicate code, different case.
    await page.goto("/localizacoes/nova");
    await page.getByLabel("Código").fill(code.toLowerCase());
    await page.getByRole("button", { name: "Criar localização" }).click();
    await expect(page.getByText("Já existe uma localização com este código.")).toBeVisible();
  });

  test("suppliers: invalid email is rejected, valid supplier is created and deactivated", async ({ page }) => {
    const name = `Fornecedor E2E ${uid()}`;
    await page.goto("/fornecedores/novo");
    await page.getByLabel("Nome").fill(name);
    await page.getByLabel("Email").fill("sem-arroba");
    await page.getByRole("button", { name: "Criar fornecedor" }).click();
    await expect(page.getByText("Indique um email válido.")).toBeVisible();

    await page.getByLabel("Email").fill("compras@exemplo.pt");
    await page.getByLabel("Telefone").fill("+351 210 000 000");
    await page.getByRole("button", { name: "Criar fornecedor" }).click();
    await expect(flash(page)).toHaveText("Fornecedor criado com sucesso.");

    await page.goto(`/fornecedores?q=${encodeURIComponent(name)}`);
    await page.getByRole("link", { name }).click();
    await page.getByRole("button", { name: "Desativar fornecedor" }).click();
    await page.getByRole("button", { name: "Sim, desativar" }).click();
    await expect(page.getByText("Inativo", { exact: true }).first()).toBeVisible();
  });

  test("projects: create and manage the status", async ({ page }) => {
    const name = `Obra E2E ${uid()}`;
    await page.goto("/projetos/novo");
    await expect(page.getByRole("combobox", { name: /Estado/ })).toHaveValue("active");
    await page.getByLabel("Nome").fill(name);
    await page.getByLabel("Cliente").fill("Cliente de teste");
    await page.getByRole("button", { name: "Criar projeto" }).click();
    await expect(flash(page)).toHaveText("Projeto criado com sucesso.");

    await page.goto(`/projetos?q=${encodeURIComponent(name)}`);
    await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("Ativo");
    await page.getByRole("link", { name }).click();

    await page.getByRole("button", { name: "Marcar como concluído" }).click();
    await page.getByRole("button", { name: "Sim, concluído" }).click();
    await expect(flash(page)).toHaveText("Projeto marcado como Concluído.");
    await expect(page.getByText("Concluído", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Reabrir projeto" }).click();
    await page.getByRole("button", { name: "Sim, ativo" }).click();
    await expect(flash(page)).toHaveText("Projeto reaberto (Ativo).");

    await page.getByRole("combobox", { name: /Estado/ }).selectOption("cancelled");
    await page.getByRole("button", { name: "Guardar alterações" }).click();
    await expect(page.getByText("Cancelado", { exact: true }).first()).toBeVisible();
    await page.goto(`/projetos?q=${encodeURIComponent(name)}&estado=cancelled`);
    await expect(page.getByRole("row", { name: new RegExp(name) })).toContainText("Cancelado");
  });

  test("unknown or malformed ids show not found", async ({ page }) => {
    for (const path of ["/categorias/00000000-0000-4000-8000-000000000000", "/projetos/abc"]) {
      await page.goto(path);
      await expect(page.getByText("Registo não encontrado")).toBeVisible();
    }
  });
});

for (const role of ["operator", "viewer"] as const) {
  test.describe(`${role} (read-only)`, () => {
    test("sees the lists and details but no management actions", async ({ page }) => {
      const data = await seedMasterData();
      await login(page, await newUser(role, `Leitura ${role}`));

      const nav = page.getByRole("navigation", { name: "Navegação principal" });
      for (const label of ["Dashboard", "Produtos", "Movimentações", "Categorias", "Localizações", "Fornecedores", "Projetos"]) {
        await expect(nav.getByRole("link", { name: label })).toBeVisible();
      }

      for (const [list, detail, createLabel, createPath] of [
        ["/categorias", `/categorias/${data.categoryId}`, "Nova categoria", "/categorias/nova"],
        ["/localizacoes", `/localizacoes/${data.locationId}`, "Nova localização", "/localizacoes/nova"],
        ["/fornecedores", `/fornecedores/${data.supplierId}`, "Novo fornecedor", "/fornecedores/novo"],
        ["/projetos", `/projetos/${data.projectId}`, "Novo projeto", "/projetos/novo"],
      ]) {
        await page.goto(`${list}?q=${data.tag}`);
        await expect(page.getByRole("link", { name: createLabel })).toHaveCount(0);
        await expect(page.getByRole("row")).toHaveCount(2); // header + fixture

        await page.goto(detail);
        await expect(page.getByRole("button", { name: "Guardar alterações" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: /Desativar|Cancelar projeto|Marcar como/ })).toHaveCount(0);
        await expect(page.locator("dl")).toBeVisible();

        await page.goto(createPath);
        await expect(page).toHaveURL(/\/sem-permissao$/);
      }
    });
  });
}

test("an inactive user cannot open the master data pages", async ({ page }) => {
  const user = await newUser("admin", "Admin Inativo Cadastros");
  await login(page, user);
  const { setProfile } = await import("../db/helpers");
  await setProfile(user.id, { active: false });
  await page.goto("/categorias");
  await expect(page).toHaveURL(/\/login\?motivo=conta-inativa$/);
});

test("mobile: lists and the grouped menu work on a small screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const data = await seedMasterData();
  await login(page, await newUser("viewer", "Consulta Mobile"));
  await page.goto(`/localizacoes?q=${data.tag}`);
  await expect(page.getByRole("link", { name: `FX-${data.tag}` })).toBeVisible();

  await page.getByRole("button", { name: "Abrir menu" }).click();
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu.getByText("Cadastros")).toBeVisible();
  await menu.getByRole("link", { name: "Fornecedores" }).click();
  await expect(page).toHaveURL(/\/fornecedores$/);
  await expect(page.getByRole("dialog", { name: "Menu" })).toHaveCount(0);
});
