import { describe, expect, it } from "vitest";
import { LOGIN_MESSAGES, loginErrorMessage, loginNotice, loginSchema } from "./login";
import { evaluateProfile } from "./profile";

describe("loginSchema", () => {
  it("normalizes the email", () => {
    const parsed = loginSchema.parse({ email: "  Demo.Operator@Example.PT ", password: "x" });
    expect(parsed.email).toBe("demo.operator@example.pt");
  });

  it("does not trim or alter the password", () => {
    expect(loginSchema.parse({ email: "a@b.pt", password: " senha com espaços " }).password).toBe(" senha com espaços ");
  });

  it.each([
    [{ email: "", password: "x" }, "email", "Indique o email."],
    [{ email: "nao-e-email", password: "x" }, "email", "Indique um email válido."],
    [{ email: "a@b.pt", password: "" }, "password", "Indique a palavra-passe."],
    [{ email: null, password: null }, "email", "Indique o email."],
  ])("rejects %j", (input, field, message) => {
    const result = loginSchema.safeParse(input);
    expect(result.success).toBe(false);
    expect(result.error?.issues.find((i) => i.path[0] === field)?.message).toBe(message);
  });
});

describe("loginErrorMessage (no account enumeration, no internal text)", () => {
  it.each(["invalid_credentials", "email_not_confirmed", "user_not_found", "user_banned"])(
    "%s → same generic message",
    (code) => {
      expect(loginErrorMessage({ code, status: 400 })).toBe(LOGIN_MESSAGES.invalidCredentials);
    },
  );

  it("maps rate limiting", () => {
    expect(loginErrorMessage({ status: 429 })).toBe(LOGIN_MESSAGES.rateLimited);
    expect(loginErrorMessage({ code: "over_request_rate_limit" })).toBe(LOGIN_MESSAGES.rateLimited);
  });

  it("never exposes unknown errors", () => {
    expect(loginErrorMessage({ code: "unexpected_failure", status: 500 })).toBe(LOGIN_MESSAGES.unavailable);
    expect(loginErrorMessage(undefined)).toBe(LOGIN_MESSAGES.unavailable);
  });
});

describe("loginNotice", () => {
  it("only accepts known keys", () => {
    expect(loginNotice("conta-inativa")?.text).toBe(LOGIN_MESSAGES.inactive);
    expect(loginNotice("<script>")).toBeNull();
    expect(loginNotice("toString")).toBeNull();
    expect(loginNotice(["conta-inativa"])).toBeNull();
  });
});

describe("evaluateProfile", () => {
  const id = "0b7f6a4e-3a0e-4c55-9d1e-2f7a1f0a9c11";
  const row = { id, name: "Demo Operator", role: "admin", active: true };

  it("accepts an active profile with a valid role", () => {
    expect(evaluateProfile(id, "b@x.pt", row)).toEqual({
      ok: true,
      user: { id, email: "b@x.pt", name: "Demo Operator", role: "admin" },
    });
  });

  it("denies a missing profile", () => {
    expect(evaluateProfile(id, null, null)).toEqual({ ok: false, reason: "no_profile" });
  });

  it("denies an inactive profile", () => {
    expect(evaluateProfile(id, null, { ...row, active: false })).toEqual({ ok: false, reason: "inactive" });
  });

  it.each([
    { ...row, role: "superadmin" },
    { ...row, role: null },
    { ...row, name: "   " },
    { ...row, active: "true" },
    { ...row, id: "3c1d2a55-0000-4000-8000-000000000000" },
    "not-an-object",
  ])("denies an invalid profile %#", (bad) => {
    expect(evaluateProfile(id, null, bad)).toEqual({ ok: false, reason: "invalid_profile" });
  });
});
