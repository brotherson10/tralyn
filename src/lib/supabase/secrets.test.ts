import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The service role key bypasses RLS. It may only be used by CLI scripts
 * outside src/, never by application code that could reach the browser.
 */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") ? [path] : [];
  });
}

describe("secret handling", () => {
  it("never references the service role key inside src/", () => {
    const offenders = listSourceFiles(join(process.cwd(), "src")).filter((file) =>
      /SERVICE_ROLE|SUPABASE_SECRET/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("never logs passwords, tokens, sessions or cookies", () => {
    const offenders = listSourceFiles(join(process.cwd(), "src")).flatMap((file) =>
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => /console\.\w+\(/.test(line) && /password|token|session\b|claims|cookie|email/i.test(line))
        .map((line) => `${file}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("offers no public sign-up or anonymous sign-in in the application", () => {
    const offenders = listSourceFiles(join(process.cwd(), "src")).filter((file) =>
      /auth\.signUp\(|signInAnonymously\(/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
