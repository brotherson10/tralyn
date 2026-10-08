import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FORBIDDEN_ERROR, NOT_FOUND_OR_FORBIDDEN_ERROR } from "@/lib/db/errors";
import {
  createCategory,
  getCategory,
  listCategories,
  setCategoryActive,
  updateCategory,
} from "@/services/master-data/categories";
import { createLocation, listLocations, setLocationActive, updateLocation } from "@/services/master-data/locations";
import { createProject, listProjects, setProjectStatus, updateProject } from "@/services/master-data/projects";
import { createSupplier, listSuppliers, setSupplierActive, updateSupplier } from "@/services/master-data/suppliers";
import type { MutationResult } from "@/services/master-data/shared";
import {
  categorySchema,
  locationSchema,
  projectSchema,
  supplierSchema,
} from "@/validation/master-data";
import { closeDb, createUser, db, setProfile, signIn, uid, type Client } from "./helpers";

/**
 * Master data services exercised through real sessions (publishable key +
 * user JWT), so RLS is always in effect. No service-role key is used.
 */

let admin: Client;
let operator: Client;
let viewer: Client;
let inactive: Client;

beforeAll(async () => {
  [admin, operator, viewer] = await Promise.all([
    createUser("admin").then(signIn),
    createUser("operator").then(signIn),
    createUser("viewer").then(signIn),
  ]);
  const inactiveUser = await createUser("admin");
  inactive = await signIn(inactiveUser);
  await setProfile(inactiveUser.id, { active: false });
});

afterAll(closeDb);

function ok(result: MutationResult): string {
  if (!result.ok) throw new Error(`expected success, got: ${result.message} ${JSON.stringify(result.fieldErrors)}`);
  return result.id;
}

/** Unique 2–10 char uppercase prefix. */
const newPrefix = () => `T${uid().replace(/[^A-Z0-9]/g, "").slice(0, 7)}`;
const category = (overrides: Partial<Record<string, string>> = {}) =>
  categorySchema.parse({ name: `Categoria ${uid()}`, prefix: newPrefix(), description: "", ...overrides });

describe("categories", () => {
  it("admin creates, edits, deactivates and reactivates", async () => {
    const input = category({ description: "Criada no teste" });
    const id = ok(await createCategory(admin, input));

    const edited = { ...input, name: `${input.name} (editada)` };
    ok(await updateCategory(admin, id, edited));
    expect((await getCategory(admin, id))?.name).toBe(edited.name);

    ok(await setCategoryActive(admin, id, false));
    expect((await getCategory(admin, id))?.active).toBe(false);
    ok(await setCategoryActive(admin, id, true));
    expect((await getCategory(admin, id))?.active).toBe(true);
  });

  it("reports UNIQUE name and prefix as field errors (including case differences)", async () => {
    const input = category();
    ok(await createCategory(admin, input));

    const sameName = await createCategory(admin, category({ name: input.name.toUpperCase() }));
    expect(sameName).toMatchObject({ ok: false, fieldErrors: { name: "Já existe uma categoria com este nome." } });

    const samePrefix = await createCategory(admin, category({ prefix: input.prefix }));
    expect(samePrefix).toMatchObject({
      ok: false,
      fieldErrors: { prefix: "Este prefixo já está a ser usado por outra categoria." },
    });
  });

  it("editing a record keeps its own name valid (no false duplicate)", async () => {
    const input = category();
    const id = ok(await createCategory(admin, input));
    ok(await updateCategory(admin, id, { ...input, description: "só a descrição mudou" }));
  });

  it("the database still rejects an invalid prefix if validation is bypassed", async () => {
    const result = await createCategory(admin, { name: `Categoria ${uid()}`, prefix: "in v", description: null });
    expect(result).toMatchObject({ ok: false, fieldErrors: { prefix: expect.stringMatching(/2 a 10 letras/) } });
  });

  it("searches by name/prefix/description and filters by state", async () => {
    const marker = `Busca${uid()}`;
    const activeId = ok(await createCategory(admin, category({ name: `${marker} Ativa` })));
    const inactiveId = ok(await createCategory(admin, category({ name: `${marker} Inativa` })));
    ok(await setCategoryActive(admin, inactiveId, false));

    const all = await listCategories(viewer, { q: marker });
    expect(all.map((c) => c.id).sort()).toEqual([activeId, inactiveId].sort());
    expect((await listCategories(viewer, { q: marker, active: "ativos" })).map((c) => c.id)).toEqual([activeId]);
    expect((await listCategories(viewer, { q: marker, active: "inativos" })).map((c) => c.id)).toEqual([inactiveId]);

    const byPrefix = await listCategories(viewer, { q: (await getCategory(admin, activeId))!.prefix });
    expect(byPrefix.map((c) => c.id)).toContain(activeId);
  });
});

describe("read-only roles and inactive users are blocked by RLS", () => {
  let categoryId: string;
  let locationId: string;
  let supplierId: string;
  let projectId: string;

  beforeAll(async () => {
    categoryId = ok(await createCategory(admin, category()));
    locationId = ok(await createLocation(admin, locationSchema.parse({ code: `RLS-${uid()}` })));
    supplierId = ok(await createSupplier(admin, supplierSchema.parse({ name: `Fornecedor ${uid()}` })));
    projectId = ok(await createProject(admin, projectSchema.parse({ name: `Projeto ${uid()}`, status: "active" })));
  });

  it.each([
    ["operator", () => operator],
    ["viewer", () => viewer],
    ["inactive admin", () => inactive],
  ])("%s cannot create any master data", async (_label, client) => {
    const results = [
      await createCategory(client(), category()),
      await createLocation(client(), locationSchema.parse({ code: `X-${uid()}` })),
      await createSupplier(client(), supplierSchema.parse({ name: `F ${uid()}` })),
      await createProject(client(), projectSchema.parse({ name: `P ${uid()}`, status: "active" })),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, message: FORBIDDEN_ERROR });
  });

  it.each([
    ["operator", () => operator],
    ["viewer", () => viewer],
    ["inactive admin", () => inactive],
  ])("%s cannot edit, deactivate or change status", async (_label, client) => {
    const results = [
      await updateCategory(client(), categoryId, category()),
      await setCategoryActive(client(), categoryId, false),
      await updateLocation(client(), locationId, locationSchema.parse({ code: `Y-${uid()}` })),
      await setLocationActive(client(), locationId, false),
      await updateSupplier(client(), supplierId, supplierSchema.parse({ name: `G ${uid()}` })),
      await setSupplierActive(client(), supplierId, false),
      await updateProject(client(), projectId, projectSchema.parse({ name: `Q ${uid()}`, status: "cancelled" })),
      await setProjectStatus(client(), projectId, "cancelled"),
    ];
    for (const result of results) expect(result).toEqual({ ok: false, message: NOT_FOUND_OR_FORBIDDEN_ERROR });

    // Nothing changed in the database.
    const { rows } = await db().query(
      `select (select active from public.categories where id = $1) as c,
              (select active from public.locations where id = $2) as l,
              (select active from public.suppliers where id = $3) as s,
              (select status::text from public.projects where id = $4) as p`,
      [categoryId, locationId, supplierId, projectId],
    );
    expect(rows[0]).toEqual({ c: true, l: true, s: true, p: "active" });
  });

  it("operator and viewer can read; the inactive user sees nothing", async () => {
    for (const client of [operator, viewer]) {
      expect((await listCategories(client, {})).length).toBeGreaterThan(0);
      expect((await listProjects(client, {})).length).toBeGreaterThan(0);
    }
    expect(await listCategories(inactive, {})).toEqual([]);
    expect(await listLocations(inactive, {})).toEqual([]);
    expect(await listSuppliers(inactive, {})).toEqual([]);
    expect(await listProjects(inactive, {})).toEqual([]);
  });

  it("nobody can delete master data through the API", async () => {
    const { error } = await admin.from("categories").delete().eq("id", categoryId);
    expect(error?.code).toBe("42501");
  });
});

describe("locations", () => {
  it("admin creates, edits and deactivates; code UNIQUE ignores case", async () => {
    const code = `A-${uid()}`;
    const id = ok(await createLocation(admin, locationSchema.parse({ code, zone: "A", shelf: "01", position: "01" })));
    ok(await updateLocation(admin, id, locationSchema.parse({ code, zone: "B", description: "Corredor B" })));
    ok(await setLocationActive(admin, id, false));

    const duplicate = await createLocation(admin, locationSchema.parse({ code: code.toLowerCase() }));
    expect(duplicate).toMatchObject({ ok: false, fieldErrors: { code: "Já existe uma localização com este código." } });

    const found = await listLocations(viewer, { q: code, active: "inativos" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ zone: "B", shelf: null, description: "Corredor B", active: false });
  });
});

describe("suppliers", () => {
  it("admin creates, edits and deactivates; optional email is validated and name UNIQUE ignores case", async () => {
    const name = `Fornecedor ${uid()}`;
    const id = ok(await createSupplier(admin, supplierSchema.parse({ name, email: "" })));
    ok(await updateSupplier(admin, id, supplierSchema.parse({ name, email: "Compras@Exemplo.PT", phone: "+351 210 000 000" })));
    ok(await setSupplierActive(admin, id, false));

    const duplicate = await createSupplier(admin, supplierSchema.parse({ name: `  ${name.toUpperCase()} ` }));
    expect(duplicate).toMatchObject({ ok: false, fieldErrors: { name: "Já existe um fornecedor com este nome." } });

    const invalidEmail = await createSupplier(admin, { ...supplierSchema.parse({ name: `F ${uid()}` }), email: "sem-arroba" });
    expect(invalidEmail).toMatchObject({ ok: false, fieldErrors: { email: "Indique um email válido." } });

    const found = await listSuppliers(viewer, { q: "compras@exemplo" });
    expect(found.find((s) => s.id === id)).toMatchObject({ email: "compras@exemplo.pt", active: false });
  });
});

describe("projects", () => {
  it("admin creates projects and manages the status lifecycle", async () => {
    const reference = `OBRA-${uid()}`;
    const id = ok(await createProject(admin, projectSchema.parse({ name: `Obra ${uid()}`, reference, status: "active" })));

    for (const status of ["completed", "active", "cancelled"] as const) {
      ok(await setProjectStatus(admin, id, status));
      expect((await listProjects(viewer, { q: reference }))[0].status).toBe(status);
    }
    expect((await listProjects(viewer, { q: reference, status: "cancelled" })).map((p) => p.id)).toEqual([id]);
    expect(await listProjects(viewer, { q: reference, status: "active" })).toEqual([]);

    const duplicate = await createProject(admin, projectSchema.parse({ name: "Outra", reference, status: "active" }));
    expect(duplicate).toMatchObject({ ok: false, fieldErrors: { reference: "Já existe um projeto com esta referência." } });
  });

  it("the database rejects statuses outside the enum", async () => {
    const id = ok(await createProject(admin, projectSchema.parse({ name: `Obra ${uid()}`, status: "active" })));
    const result = await setProjectStatus(admin, id, "Ativo" as never);
    expect(result.ok).toBe(false);
  });
});
