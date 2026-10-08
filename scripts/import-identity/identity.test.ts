import { describe, expect, it } from "vitest";
import {
  assertLocalTarget,
  BAN_DURATION,
  IMPORT_IDENTITY,
  identityProblems,
  MIN_BAN_REMAINING_MS,
  TargetNotAllowedError,
  type IdentitySnapshot,
} from "./identity";

const NOW = new Date("2026-10-05T12:00:00Z");
const ID = "0f3c1e8a-2b4d-4c6e-8f1a-3b5d7e9f1a2c";
const inYears = (years: number) => new Date(NOW.getTime() + years * 365 * 24 * 3600 * 1000).toISOString();

const valid = (): IdentitySnapshot => ({
  users: [
    {
      id: ID,
      email: IMPORT_IDENTITY.email,
      emailConfirmedAt: "2026-10-05T11:00:00Z",
      bannedUntil: inYears(100),
      lastSignInAt: null,
      deletedAt: null,
      isAnonymous: false,
      appMetadata: { provider: "email", system_identity: "tralyn-import" },
    },
  ],
  profile: { id: ID, name: "Importação de dados", role: "viewer", active: false },
});

describe("canonical identity", () => {
  it("uses the approved technical values", () => {
    expect(IMPORT_IDENTITY).toMatchObject({
      email: "importacao@tralyn.invalid",
      name: "Importação de dados",
      role: "viewer",
    });
    expect(IMPORT_IDENTITY.email.endsWith(".invalid")).toBe(true);
  });

  it("documents the ban fallback as exactly 100 years in hours", () => {
    expect(BAN_DURATION).toBe(`${100 * 365 * 24}h`);
    expect(MIN_BAN_REMAINING_MS).toBe(99 * 365 * 24 * 3600 * 1000);
  });
});

describe("assertLocalTarget", () => {
  it.each(["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321/"])("accepts %s", (url) => {
    expect(() => assertLocalTarget(url)).not.toThrow();
  });

  it.each([
    "https://testprojectrefabcdef.supabase.co",
    "https://example.supabase.co",
    "http://127.0.0.1:54322",
    "http://127.0.0.1",
    "http://192.168.1.10:54321",
    "https://127.0.0.1:54321",
    "http://127.0.0.1.evil.example:54321",
    "not a url",
    "",
  ])("refuses %s", (url) => {
    expect(() => assertLocalTarget(url)).toThrow(TargetNotAllowedError);
  });

  it("refuses a URL carrying the linked hosted project ref", () => {
    expect(() => assertLocalTarget("http://127.0.0.1:54321/?ref=abcdefghij", ["abcdefghij"])).toThrow(/project ref/);
  });
});

describe("identityProblems", () => {
  it("accepts the exact expected state", () => {
    expect(identityProblems(valid(), NOW)).toEqual([]);
  });

  it("accepts an active profile only when explicitly expected (right after creation)", () => {
    const snapshot = valid();
    snapshot.profile!.active = true;
    expect(identityProblems(snapshot, NOW, true)).toEqual([]);
    expect(identityProblems(snapshot, NOW)).toEqual(["profile.active=true, esperado false"]);
  });

  it("rejects zero or several accounts", () => {
    expect(identityProblems({ users: [], profile: null }, NOW)[0]).toMatch(/encontrados 0/);
    const two = valid();
    two.users.push({ ...two.users[0], id: "other" });
    expect(identityProblems(two, NOW)[0]).toMatch(/encontrados 2/);
  });

  const mutations: [string, (s: IdentitySnapshot) => void, RegExp][] = [
    ["name", (s) => (s.profile!.name = "Demo Operator"), /profile.name/],
    ["role admin", (s) => (s.profile!.role = "admin"), /profile.role/],
    ["role operator", (s) => (s.profile!.role = "operator"), /profile.role/],
    ["active", (s) => (s.profile!.active = true), /profile.active/],
    ["no ban", (s) => (s.users[0].bannedUntil = null), /não bloqueada/],
    ["short ban", (s) => (s.users[0].bannedUntil = inYears(1)), /demasiado curto/],
    ["expired ban", (s) => (s.users[0].bannedUntil = inYears(-1)), /demasiado curto/],
    ["signed in", (s) => (s.users[0].lastSignInAt = "2026-10-05T11:30:00Z"), /iniciou sessão/],
    ["unconfirmed", (s) => (s.users[0].emailConfirmedAt = null), /não confirmado/],
    ["soft deleted", (s) => (s.users[0].deletedAt = "2026-10-05T11:30:00Z"), /apagado/],
    ["anonymous", (s) => (s.users[0].isAnonymous = true), /anónimo/],
    ["missing marker", (s) => (s.users[0].appMetadata = { provider: "email" }), /marcador/],
    ["e-mail case", (s) => (s.users[0].email = IMPORT_IDENTITY.email.toUpperCase()), /email/],
    ["missing profile", (s) => (s.profile = null), /profile inexistente/],
    ["profile id", (s) => (s.profile!.id = "different"), /profile.id/],
  ];

  it.each(mutations)("rejects a divergent %s", (_label, mutate, expected) => {
    const snapshot = valid();
    mutate(snapshot);
    const problems = identityProblems(snapshot, NOW);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(" | ")).toMatch(expected);
  });
});
