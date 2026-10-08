import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonClient, closeDb, createUser, db, pgError, setProfile, signIn, uid, type Client, type TestUser } from "./helpers";

/**
 * Import audit tables. Writes happen as the table owner over a direct
 * connection (how the future importer works); reads are checked through the
 * Data API with real sessions, so RLS and grants are in effect.
 */

// The generated Database types do not include these tables yet (they are not
// used by the application); an untyped client is enough for the API checks.
const api = (client: Client) => client as unknown as SupabaseClient;

const sha = () => createHash("sha256").update(randomUUID()).digest("hex");

let adminUser: TestUser;
let admin: Client;
let operator: Client;
let viewer: Client;
let inactive: Client;
let batchId: string;
let recordId: string;

async function insertBatch(fields: Partial<Record<string, unknown>> = {}): Promise<string> {
  const row = {
    source_file: "demo_inventory.xlsx",
    source_sha256: sha(),
    import_version: "test-v1",
    executed_by: null,
    summary: { products: 12 },
    ...fields,
  };
  const { rows } = await db().query<{ id: string }>(
    `insert into public.import_batches (source_file, source_sha256, import_version, executed_by, summary)
     values ($1, $2, $3, $4, $5::jsonb) returning id`,
    [row.source_file, row.source_sha256, row.import_version, row.executed_by, JSON.stringify(row.summary)],
  );
  return rows[0].id;
}

async function insertRecord(fields: Partial<Record<string, unknown>> = {}): Promise<string> {
  const row = {
    batch_id: batchId,
    entity_type: "product",
    entity_id: randomUUID(),
    source_reference: `test:product:${uid()}`,
    source_sheet: "PRODUTOS",
    source_row: 2,
    action: "created",
    source_data: { code: "INV-201", responsavel: "Demo Operator" },
    ...fields,
  };
  const { rows } = await db().query<{ id: string }>(
    `insert into public.import_records (batch_id, entity_type, entity_id, source_reference, source_sheet, source_row, action, source_data)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning id`,
    [row.batch_id, row.entity_type, row.entity_id, row.source_reference, row.source_sheet, row.source_row, row.action, JSON.stringify(row.source_data)],
  );
  return rows[0].id;
}

const constraintError = async (fn: () => Promise<unknown>) => {
  const error = await pgError(fn);
  return `${error.code} ${error.message}`;
};

beforeAll(async () => {
  adminUser = await createUser("admin");
  [admin, operator, viewer] = await Promise.all([
    signIn(adminUser),
    createUser("operator").then(signIn),
    createUser("viewer").then(signIn),
  ]);
  const inactiveUser = await createUser("admin");
  inactive = await signIn(inactiveUser);
  await setProfile(inactiveUser.id, { active: false });

  batchId = await insertBatch({ executed_by: adminUser.id });
  recordId = await insertRecord();
});

afterAll(closeDb);

describe("import_batches constraints", () => {
  it("accepts a valid batch with defaults (single imported_at, summary {})", async () => {
    const { rows } = await db().query(
      `insert into public.import_batches (source_file, source_sha256, import_version)
       values ('demo_inventory.xlsx', $1, 'test-v1') returning imported_at, summary, executed_by`,
      [sha()],
    );
    expect(rows[0]).toMatchObject({ summary: {}, executed_by: null });
    expect(rows[0].imported_at).toBeInstanceOf(Date);
  });

  it.each(["ABC", "g".repeat(64), "A".repeat(64), "a".repeat(63), ""])("rejects SHA-256 %j", async (value) => {
    expect(await constraintError(() => insertBatch({ source_sha256: value }))).toMatch(/23514.*import_batches_source_sha256_format/);
  });

  it.each(["", "   "])("rejects import_version %j", async (value) => {
    expect(await constraintError(() => insertBatch({ import_version: value }))).toMatch(/23514.*import_batches_import_version_not_blank/);
  });

  it.each([[[]], ["texto"], [1]])("rejects summary that is not an object: %j", async (value) => {
    expect(await constraintError(() => insertBatch({ summary: value }))).toMatch(/23514.*import_batches_summary_is_object/);
  });

  it.each(["/home/user/data/inv.xlsx", "C:\\Users\\x\\inv.xlsx", "data/inv.xlsx", "C:inv.xlsx", "", " inv.xlsx"])(
    "rejects source_file that is a path or blank: %j",
    async (value) => {
      expect(await constraintError(() => insertBatch({ source_file: value }))).toMatch(/23514.*import_batches_source_file_name/);
    },
  );

  it("executed_by must reference an existing profile, and that profile can no longer be deleted", async () => {
    expect(await constraintError(() => insertBatch({ executed_by: randomUUID() }))).toMatch(/^23503/);

    const account = await createUser("viewer");
    await insertBatch({ executed_by: account.id });
    // profiles cascade from auth.users, but the RESTRICT FK keeps the audit trail intact.
    expect(await constraintError(() => db().query(`delete from auth.users where id = $1`, [account.id]))).toMatch(/^23503/);
  });
});

describe("import_records constraints", () => {
  it("accepts a valid record", async () => {
    const { rows } = await db().query(`select entity_type, action, source_data from public.import_records where id = $1`, [recordId]);
    expect(rows[0]).toMatchObject({ entity_type: "product", action: "created", source_data: { responsavel: "Demo Operator" } });
  });

  it("rejects a non-existent batch", async () => {
    expect(await constraintError(() => insertRecord({ batch_id: randomUUID() }))).toMatch(/^23503/);
  });

  it.each([
    ["source_reference ''", { source_reference: "" }, "import_records_source_reference_format"],
    ["source_reference with spaces around", { source_reference: " ref " }, "import_records_source_reference_format"],
    ["source_sheet ''", { source_sheet: " " }, "import_records_source_sheet_not_blank"],
    ["source_row 0", { source_row: 0 }, "import_records_source_row_positive"],
    ["source_row -1", { source_row: -1 }, "import_records_source_row_positive"],
    ["source_data array", { source_data: [] }, "import_records_source_data_is_object"],
    ["source_data string", { source_data: "x" }, "import_records_source_data_is_object"],
    ["entity_type 'supplier'", { entity_type: "supplier" }, "import_records_entity_type_allowed"],
    ["action 'updated'", { action: "updated" }, "import_records_action_allowed"],
  ])("rejects %s", async (_label, fields, constraint) => {
    expect(await constraintError(() => insertRecord(fields))).toMatch(new RegExp(`23514.*${constraint}`));
  });

  it.each(["created", "already_present"])("rejects entity_id NULL (NOT NULL, 23502) for action %s", async (action) => {
    const error = await pgError(() => insertRecord({ entity_id: null, action }));
    expect(error.code).toBe("23502");
    expect(error.message).toContain("entity_id");
  });

  it("accepts source_row NULL (items without a sheet row)", async () => {
    expect(await insertRecord({ source_row: null })).toBeTruthy();
  });

  it.each(["category", "location", "product", "stock_movement"])("accepts entity_type %s", async (entityType) => {
    expect(await insertRecord({ entity_type: entityType })).toBeTruthy();
  });
});

describe("idempotency", () => {
  it("records each (entity_type, source_reference) once per batch", async () => {
    const reference = `test:product:${uid()}`;
    await insertRecord({ source_reference: reference });
    expect(await constraintError(() => insertRecord({ source_reference: reference, action: "already_present" }))).toMatch(
      /23505.*import_records_batch_item_key/,
    );
    // Same reference for another entity type in the same batch is a different item.
    expect(await insertRecord({ source_reference: reference, entity_type: "stock_movement" })).toBeTruthy();
  });

  it("a later batch can record the item as already_present, but never create it again", async () => {
    const reference = `test:product:${uid()}`;
    const entityId = randomUUID();
    await insertRecord({ source_reference: reference, entity_id: entityId });

    const rerun = await insertBatch();
    expect(await insertRecord({ batch_id: rerun, source_reference: reference, entity_id: entityId, action: "already_present" })).toBeTruthy();

    const third = await insertBatch();
    expect(
      await constraintError(() => insertRecord({ batch_id: third, source_reference: reference, entity_id: randomUUID() })),
    ).toMatch(/23505.*import_records_created_once_key/);

    const { rows } = await db().query(
      `select action, count(*)::int as n from public.import_records where source_reference = $1 group by action order by action`,
      [reference],
    );
    expect(rows).toEqual([
      { action: "already_present", n: 1 },
      { action: "created", n: 1 },
    ]);
  });
});

describe("immutability (even for the table owner)", () => {
  it.each([
    ["UPDATE batch", () => db().query(`update public.import_batches set import_version = 'X' where id = $1`, [batchId])],
    ["DELETE batch", () => db().query(`delete from public.import_batches where id = $1`, [batchId])],
    ["UPDATE record", () => db().query(`update public.import_records set action = 'already_present' where id = $1`, [recordId])],
    ["DELETE record", () => db().query(`delete from public.import_records where id = $1`, [recordId])],
    ["TRUNCATE records", () => db().query(`truncate public.import_records`)],
    ["TRUNCATE both", () => db().query(`truncate public.import_batches, public.import_records`)],
  ])("%s is rejected", async (_label, fn) => {
    expect((await pgError(fn)).message).toBe("IMMUTABLE_IMPORT_AUDIT");
  });

  it("the rows are unchanged", async () => {
    const { rows } = await db().query(
      `select b.import_version, r.action from public.import_batches b join public.import_records r on r.batch_id = b.id where r.id = $1`,
      [recordId],
    );
    expect(rows[0]).toEqual({ import_version: "test-v1", action: "created" });
  });
});

describe("RLS and grants through the Data API", () => {
  it("admin can read batches and records", async () => {
    const batches = await api(admin).from("import_batches").select("id").eq("id", batchId);
    const records = await api(admin).from("import_records").select("id, batch_id").eq("id", recordId);
    expect(batches.data).toEqual([{ id: batchId }]);
    expect(records.data).toEqual([{ id: recordId, batch_id: batchId }]);
  });

  it.each([
    ["operator", () => operator],
    ["viewer", () => viewer],
    ["inactive admin", () => inactive],
  ])("%s sees nothing", async (_label, client) => {
    for (const table of ["import_batches", "import_records"]) {
      const { data, error } = await api(client()).from(table).select("id").limit(5);
      expect(error, table).toBeNull();
      expect(data, table).toEqual([]);
    }
  });

  it("anon has no access at all", async () => {
    for (const table of ["import_batches", "import_records"]) {
      const { error } = await (anonClient() as unknown as SupabaseClient).from(table).select("id").limit(1);
      expect(error?.code, table).toBe("42501");
    }
  });

  it("no application role can insert, update or delete", async () => {
    const clients: [string, SupabaseClient][] = [
      ["admin", api(admin)],
      ["operator", api(operator)],
      ["viewer", api(viewer)],
      ["anon", anonClient() as unknown as SupabaseClient],
    ];
    for (const [label, client] of clients) {
      const insert = await client
        .from("import_batches")
        .insert({ source_file: "x.xlsx", source_sha256: sha(), import_version: "test-v1" });
      const insertRecord = await client.from("import_records").insert({
        batch_id: batchId,
        entity_type: "product",
        entity_id: randomUUID(),
        source_reference: `api:${uid()}`,
        source_sheet: "PRODUTOS",
        action: "created",
        source_data: {},
      });
      const update = await client.from("import_batches").update({ import_version: "X" }).eq("id", batchId);
      const remove = await client.from("import_records").delete().eq("id", recordId);
      for (const [op, result] of [
        ["insert batch", insert],
        ["insert record", insertRecord],
        ["update", update],
        ["delete", remove],
      ] as const) {
        expect(result.error?.code, `${label} ${op}`).toBe("42501");
      }
    }
  });
});
