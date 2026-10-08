/**
 * Offline inspection of the legacy inventory workbook (no database access).
 *
 *   npm run inventory:parse -- fixtures/tralyn-demo.xlsx
 *
 * Prints a sanitized summary (SHA, sheets, counts, issues, reconciliation,
 * plan summary) — never the workbook rows. Exit code: 0 valid plan,
 * 1 validation failed, 2 usage / unreadable file.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { CANONICAL_EXPECTATIONS } from "./inventory-import/expectations";
import { buildImportPlan, sha256Hex } from "./inventory-import/pipeline";

function main(): number {
  const [path, ...extra] = process.argv.slice(2);
  if (!path || extra.length > 0) {
    console.error("Uso: npm run inventory:parse -- <caminho/workbook.xlsx>");
    return 2;
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    console.error("Ficheiro não encontrado ou ilegível.");
    return 2;
  }

  const fileName = basename(path);
  const result = buildImportPlan({ fileName, bytes });
  const parsed = result.parsed;
  const summary: Record<string, unknown> = {
    file: {
      name: fileName,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      expectedSha256: CANONICAL_EXPECTATIONS.sha256,
    },
    sheets: parsed ? { found: parsed.sheetNames, ignored: parsed.ignoredSheets } : null,
    rawCounts: parsed?.rawCounts ?? null,
    valid: result.ok,
    errors: result.ok ? [] : result.errors,
    warnings: result.warnings,
  };

  if (result.ok) {
    const { plan } = result;
    const opening = plan.movements.filter((m) => m.kind === "opening");
    const historical = plan.movements.filter((m) => m.kind === "historical");
    const special = (code: string) => {
      const product = plan.products.find((p) => p.code === code)!;
      return {
        brand: product.brand,
        model: product.model,
        opening: opening.find((m) => m.productCode === code)?.quantity ?? null,
        historical: historical.filter((m) => m.productCode === code).map((m) => ({ type: m.type, quantity: m.quantity, createdAt: m.createdAt })),
      };
    };
    summary.reconciliation = plan.reconciliation;
    summary.plan = {
      importVersion: plan.source.importVersion,
      executedBy: plan.executedByEmail,
      categories: plan.categories.length,
      locations: plan.locations.map((l) => l.code),
      suppliers: 0,
      products: plan.products.length,
      openingBalances: { count: opening.length, quantity: opening.reduce((s, m) => s + m.quantity, 0) },
      historicalMovements: historical.map((m) => ({ product: m.productCode, type: m.type, quantity: m.quantity, createdAt: m.createdAt, sourceReference: m.sourceReference })),
      records: plan.records.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.entityType]: (acc[r.entityType] ?? 0) + 1 }), {}),
      sampleReferences: [
        plan.categories[0]?.sourceReference,
        plan.locations[0]?.sourceReference,
        plan.products[0]?.sourceReference,
        opening[0]?.sourceReference,
        historical[0]?.sourceReference,
      ],
      specialProducts: Object.fromEntries(CANONICAL_EXPECTATIONS.specialProducts.map(({ code }) => [code, special(code)])),
    };
  }

  console.log(JSON.stringify(summary, null, 2));
  return result.ok ? 0 : 1;
}

process.exitCode = main();
