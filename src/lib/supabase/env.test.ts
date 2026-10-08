import { describe, expect, it } from "vitest";
import { parseSupabasePublicEnv } from "./env";

const KEY = "sb_publishable_0123456789abcdefghij";

describe("parseSupabasePublicEnv", () => {
  it("reports missing configuration with an actionable message", () => {
    const result = parseSupabasePublicEnv({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(".env.local");
  });

  it("accepts a URL and a publishable key", () => {
    expect(parseSupabasePublicEnv({ url: "https://abc.supabase.co", publishableKey: KEY })).toEqual({
      ok: true,
      env: { url: "https://abc.supabase.co", key: KEY },
    });
  });

  it("falls back to the legacy anon key name", () => {
    const result = parseSupabasePublicEnv({ url: "http://127.0.0.1:54321", anonKey: KEY });
    expect(result).toMatchObject({ ok: true, env: { key: KEY } });
  });

  it("prefers the publishable key over the anon key", () => {
    const result = parseSupabasePublicEnv({
      url: "https://abc.supabase.co",
      publishableKey: KEY,
      anonKey: "legacy-anon-key-value-xxxxxxxx",
    });
    expect(result).toMatchObject({ ok: true, env: { key: KEY } });
  });

  it("rejects an invalid URL", () => {
    expect(parseSupabasePublicEnv({ url: "not a url", publishableKey: KEY }).ok).toBe(false);
    expect(parseSupabasePublicEnv({ url: "ftp://abc.supabase.co", publishableKey: KEY }).ok).toBe(false);
  });

  it("treats whitespace-only values as missing", () => {
    expect(parseSupabasePublicEnv({ url: "  ", publishableKey: "  " }).ok).toBe(false);
  });
});
