import { describe, expect, it } from "vitest";
import { parsePublicDemoViewer } from "./public-demo";

// Fictitious values only.
const EMAIL = "viewer.example@demo.invalid";
const PASSWORD = "not-a-real-password";

describe("parsePublicDemoViewer", () => {
  it("returns the credentials when both are valid (e-mail normalized)", () => {
    expect(parsePublicDemoViewer({ email: `  ${EMAIL.toUpperCase()} `, password: PASSWORD })).toEqual({ email: EMAIL, password: PASSWORD });
  });

  it.each([
    ["both missing", {}],
    ["e-mail missing", { password: PASSWORD }],
    ["password missing", { email: EMAIL }],
    ["empty values", { email: "", password: "" }],
    ["blank e-mail", { email: "   ", password: PASSWORD }],
    ["invalid e-mail", { email: "not-an-email", password: PASSWORD }],
    ["empty password", { email: EMAIL, password: "" }],
    ["password too long", { email: EMAIL, password: "x".repeat(201) }],
  ])("returns null when %s", (_case, raw) => {
    expect(parsePublicDemoViewer(raw)).toBeNull();
  });
});
