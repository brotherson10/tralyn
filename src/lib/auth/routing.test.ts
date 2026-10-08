import { describe, expect, it } from "vitest";
import { decideRoute, isPublicPath, safeNextPath } from "./routing";

describe("safeNextPath (open-redirect protection)", () => {
  it.each(["/dashboard", "/produtos?categoria=INV", "/produtos/abc-123"])("accepts %s", (path) => {
    expect(safeNextPath(path)).toBe(path);
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "dashboard",
    "/login",
    "/auth/encerrar",
    "/a\nb",
    "",
    null,
    42,
  ])("rejects %s", (value) => {
    expect(safeNextPath(value)).toBeNull();
  });
});

describe("decideRoute", () => {
  const route = (pathname: string, authenticated: boolean, search = "") =>
    decideRoute({ pathname, search, authenticated });

  it("redirects anonymous users from protected pages to /login with the target", () => {
    expect(route("/produtos", false, "?q=inv")).toEqual({
      action: "redirect",
      location: "/login?next=%2Fprodutos%3Fq%3Dinv",
    });
    expect(route("/", false)).toEqual({ action: "redirect", location: "/login" });
  });

  it("allows authenticated users into protected pages", () => {
    expect(route("/dashboard", true)).toEqual({ action: "allow" });
  });

  it("sends authenticated users away from /login", () => {
    expect(route("/login", true)).toEqual({ action: "redirect", location: "/dashboard" });
    expect(route("/login", false)).toEqual({ action: "allow" });
  });

  it("protects unknown routes by default and answers 401 for APIs", () => {
    expect(route("/qualquer-coisa-nova", false).action).toBe("redirect");
    expect(route("/api/products", false)).toEqual({ action: "unauthorized" });
  });

  it("keeps only the explicit public routes open", () => {
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/auth/encerrar")).toBe(true);
    expect(isPublicPath("/signup")).toBe(false);
    expect(route("/api/health", false)).toEqual({ action: "allow" });
  });
});
