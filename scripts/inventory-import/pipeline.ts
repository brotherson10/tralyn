/**
 * Full pipeline: file identity (name + SHA-256) → RAW → PARSED → NORMALIZED →
 * VALIDATED → IMPORT PLAN. Fail-closed: any error means no plan. Pure: it
 * receives the bytes and never touches a database.
 */
import { createHash } from "node:crypto";
import { CANONICAL_EXPECTATIONS, type ImportExpectations } from "./expectations";
import type { PipelineResult, ValidationIssue } from "./model";
import { normalize } from "./normalize";
import { buildPlan } from "./plan";
import { parseWorkbook, readRawWorkbook } from "./workbook";

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function buildImportPlan(
  input: { fileName: string; bytes: Uint8Array },
  expectations: ImportExpectations = CANONICAL_EXPECTATIONS,
): PipelineResult {
  const errors: ValidationIssue[] = [];
  const split = (issues: ValidationIssue[]) => {
    errors.push(...issues.filter((i) => i.severity === "error"));
    warnings.push(...issues.filter((i) => i.severity === "warning"));
  };
  const warnings: ValidationIssue[] = [];

  // 1. File identity before any parsing.
  if (input.fileName !== expectations.fileName) {
    errors.push({ severity: "error", code: "FILE_NAME_MISMATCH", message: `Nome do ficheiro "${input.fileName}" ≠ "${expectations.fileName}".` });
  }
  const sha256 = sha256Hex(input.bytes);
  if (sha256 !== expectations.sha256) {
    errors.push({ severity: "error", code: "FILE_HASH_MISMATCH", message: `SHA-256 ${sha256} ≠ esperado ${expectations.sha256}.` });
  }
  if (errors.length > 0) return { ok: false, errors, warnings, parsed: null };

  // 2. RAW → PARSED.
  let parsedResult: ReturnType<typeof parseWorkbook>;
  try {
    parsedResult = parseWorkbook(readRawWorkbook(input.bytes));
  } catch {
    errors.push({ severity: "error", code: "WORKBOOK_UNREADABLE", message: "Não foi possível ler o workbook." });
    return { ok: false, errors, warnings, parsed: null };
  }
  split(parsedResult.issues);
  const parsed = parsedResult.parsed;
  if (!parsed || errors.length > 0) return { ok: false, errors, warnings, parsed };

  // 3. PARSED → NORMALIZED.
  const normalized = normalize(parsed, expectations);
  split(normalized.issues);
  if (errors.length > 0) return { ok: false, errors, warnings, parsed };

  // 4. VALIDATED → IMPORT PLAN.
  const planned = buildPlan(normalized.data, { fileName: input.fileName, sha256 }, expectations);
  split(planned.issues);
  if (!planned.plan || errors.length > 0) return { ok: false, errors, warnings, parsed };

  return { ok: true, plan: planned.plan, warnings, parsed };
}
