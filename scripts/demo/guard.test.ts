import { describe, expect, it } from "vitest";
import { DEMO_OPERATIONS, DEMO_PROJECTS, DEMO_SUPPLIER_LINKS, DEMO_SUPPLIERS, DEMO_USERS } from "./data";
import { demoArgsProblems, demoTargetProblems, FORBIDDEN_ENV, type DemoTargetFacts } from "./guard";
import { demoStateProblems } from "./setup";
import { DEMO_VISUAL_STATE } from "./state";

const local = (overrides: Partial<DemoTargetFacts> = {}): DemoTargetFacts => ({
  env: {},
  projectId: "tralyn",
  linkedRef: null,
  apiUrl: "http://127.0.0.1:54321",
  dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
  ...overrides,
});

describe("demo local-only guard", () => {
  it("accepts only the running local `tralyn` stack", () => {
    expect(demoTargetProblems(local())).toEqual([]);
    expect(demoTargetProblems(local({ env: { NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" } }))).toEqual([]);
  });

  it.each<[string, Partial<DemoTargetFacts>, RegExp]>([
    ["hosted API URL", { apiUrl: "https://testprojectrefabcdef.supabase.co" }, /API/],
    ["hosted database", { dbUrl: "postgresql://postgres:x@db.testprojectrefabcdef.supabase.co:5432/postgres" }, /DB: host/],
    ["pooler database", { dbUrl: "postgresql://postgres.testprojectrefabcdef:x@aws-0-eu-west-2.pooler.supabase.com:5432/postgres" }, /DB: host/],
    ["unexpected local DB port", { dbUrl: "postgresql://postgres:postgres@127.0.0.1:5432/postgres" }, /porta/],
    ["parameters that could redirect libpq", { dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=db.example.com" }, /parâmetros/],
    ["unexpected API port", { apiUrl: "http://127.0.0.1:8000" }, /porta/],
    ["linked hosted ref inside a URL", { linkedRef: "testprojectrefabcdef", apiUrl: "http://127.0.0.1:54321/testprojectrefabcdef" }, /project ref/],
    ["other project_id", { projectId: "other-project" }, /project_id/],
    ["stack not running", { apiUrl: undefined, dbUrl: undefined }, /não está a correr/],
    ["hosted NEXT_PUBLIC_SUPABASE_URL", { env: { NEXT_PUBLIC_SUPABASE_URL: "https://testprojectrefabcdef.supabase.co" } }, /NEXT_PUBLIC_SUPABASE_URL/],
    ["hosted import URL", { env: { INVENTORY_IMPORT_DATABASE_URL: "postgresql://u:p@db.example.com:5432/postgres" } }, /INVENTORY_IMPORT_DATABASE_URL/],
  ])("refuses: %s", (_label, overrides, reason) => {
    expect(demoTargetProblems(local(overrides)).join(" | ")).toMatch(reason);
  });

  it("refuses every hosted-only environment variable", () => {
    for (const name of FORBIDDEN_ENV) {
      expect(demoTargetProblems(local({ env: { [name]: "x" } })), name).toEqual([expect.stringContaining(name)]);
    }
  });

  it("accepts no arguments at all (no --force, --hosted or --skip-safety)", () => {
    expect(demoArgsProblems([])).toEqual([]);
    for (const arg of ["--force-production", "--hosted", "--skip-safety", "--url=http://x"]) expect(demoArgsProblems([arg])).toHaveLength(1);
  });
});

describe("demo data", () => {
  it("is fictional: reserved e-mail domains only", () => {
    for (const u of DEMO_USERS) expect(u.email).toMatch(/@tralyn\.test$/);
    for (const s of DEMO_SUPPLIERS) expect(s.email).toMatch(/\.example$/);
    expect(DEMO_USERS.map((u) => u.role)).toEqual(["admin", "operator", "viewer"]);
  });

  it("is internally consistent (projects, suppliers, actors)", () => {
    const projects = new Set(DEMO_PROJECTS.map((p) => p.name));
    const suppliers = new Set(DEMO_SUPPLIERS.map((s) => s.name));
    expect(DEMO_OPERATIONS.every((op) => op.project === null || projects.has(op.project))).toBe(true);
    expect(Object.values(DEMO_SUPPLIER_LINKS).every((name) => suppliers.has(name))).toBe(true);
    // Operators only move stock in/out; adjustments are admin-only (same rule as the RPC).
    expect(DEMO_OPERATIONS.filter((op) => op.type.startsWith("ADJUSTMENT")).every((op) => op.actor === "admin" && op.notes)).toBe(true);
    expect(new Set(DEMO_PROJECTS.map((p) => p.finalStatus))).toEqual(new Set(["active", "completed", "cancelled"]));
  });

  it("the pinned visual state differs from the canonical import state and is self-consistent", () => {
    const balances = Object.values(DEMO_VISUAL_STATE.balances);
    expect(balances.reduce((a, b) => a + b, 0)).toBe(DEMO_VISUAL_STATE.totalStock);
    expect(Math.min(...balances)).toBe(DEMO_VISUAL_STATE.minBalance);
    const moves = Object.values(DEMO_VISUAL_STATE.movementsByType).reduce((a, m) => a + m.count, 0);
    expect(moves).toBe(DEMO_VISUAL_STATE.counts.stockMovements);
    expect(DEMO_VISUAL_STATE.statusCounts).not.toEqual({ OUT_OF_STOCK: 2, REORDER: 3, OK: 7 });
  });

  it("state comparison ignores key order but reports any difference", () => {
    const reordered = structuredClone(DEMO_VISUAL_STATE);
    reordered.projectsByStatus = { cancelled: 1, completed: 1, active: 1 };
    expect(demoStateProblems(reordered, DEMO_VISUAL_STATE)).toEqual([]);
    reordered.totalStock += 1;
    expect(demoStateProblems(reordered, DEMO_VISUAL_STATE)).toEqual(["totalStock difere"]);
  });
});
