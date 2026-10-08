import { describe, expect, it } from "vitest";
import { ADVISORY_LOCK_KEY } from "./importer";
import { assertLocalDatabaseUrl, ImportTargetError } from "./target";

describe("importer target guard (local only)", () => {
  it.each([
    "postgresql://u:p@127.0.0.1:54322/postgres",
    "postgres://u:p@127.0.0.1/db",
    "postgresql://u:p@[::1]:54322/postgres",
    "postgresql://u:p@localhost:54322/postgres",
  ])("accepts %s", async (url) => {
    await expect(assertLocalDatabaseUrl(url)).resolves.toMatchObject({ database: expect.any(String) });
  });

  it.each([
    [undefined, /não definida/],
    ["", /não definida/],
    ["not a url", /inválida/],
    ["mysql://u:p@127.0.0.1/db", /protocolo/],
    ["postgresql://postgres:x@db.testprojectrefabcdef.supabase.co:5432/postgres", /hospedado/],
    ["postgresql://postgres.testprojectrefabcdef:x@aws-0-eu-west-1.pooler.supabase.com:6543/postgres", /hospedado/],
    ["postgresql://u:p@10.0.0.5:5432/postgres", /loopback/],
    ["postgresql://u:p@192.168.1.10/postgres", /loopback/],
    ["postgresql://u:p@db.example.com/postgres", /loopback/],
    ["postgresql://u:p@[2001:db8::1]/postgres", /loopback/],
    ["postgresql://u:p@127.0.0.1:54322/postgres?host=db.example.com", /parâmetros/],
    ["postgresql://u:p@127.0.0.1:54322/postgres?sslmode=require", /parâmetros/],
    ["postgresql://u:p@127.0.0.1:54322/", /base de dados/],
    ["postgresql:///postgres", /host/],
  ])("refuses %s", async (url, reason) => {
    const error = await assertLocalDatabaseUrl(url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportTargetError);
    expect((error as Error).message).toMatch(reason);
  });

  it("never echoes the connection string (password) in the error", async () => {
    const error = (await assertLocalDatabaseUrl("postgresql://u:S3cretPass@db.example.com/postgres").catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain("S3cretPass");
    expect(error.message).not.toContain("db.example.com");
  });
});

describe("advisory lock key", () => {
  it("is a stable, pinned signed 64-bit integer", () => {
    expect(ADVISORY_LOCK_KEY).toMatch(/^-?\d+$/);
    const value = BigInt(ADVISORY_LOCK_KEY);
    const limit = BigInt(2) ** BigInt(63);
    expect(value >= -limit && value < limit).toBe(true);
    // Pinned: changing it would let an old and a new importer run concurrently.
    expect(ADVISORY_LOCK_KEY).toBe("1715638129914392095");
  });
});
