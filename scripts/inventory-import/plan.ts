/**
 * NORMALIZED → VALIDATED → IMPORT PLAN. Replays the future ledger in memory,
 * reconciles it with the workbook and with the canonical expectations, and
 * builds a deterministic plan (same file → byte-identical plan).
 */
import { createHash } from "node:crypto";
import { signedQuantity } from "@/lib/stock/ledger";
import { dayStartInLisbon } from "@/validation/movements";
import { EXECUTED_BY_EMAIL, IMPORT_VERSION, SOURCE_REFERENCE_PREFIX, type ImportExpectations } from "./expectations";
import type {
  ImportPlan,
  NormalizedData,
  NormalizedHistoricalMovement,
  PlannedMovement,
  PlannedRecord,
  Reconciliation,
  ValidationIssue,
} from "./model";

const ref = (kind: string, id: string) => `${SOURCE_REFERENCE_PREFIX}:${kind}:${id}`;

/** ASCII identifier for references: "Pavilhão Norte" → "PAVILHAO-NORTE". */
export function referenceSlug(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stable fingerprint of the normalized movement fields (not the row number). */
export function movementFingerprint(m: NormalizedHistoricalMovement): string {
  const canonical = JSON.stringify([m.date, m.legacyType, m.productCode, m.legacyQuantity, m.responsible, m.project, m.document, m.notes]);
  return createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 16);
}

/** Movement references: fingerprint + occurrence counter for identical rows (in sheet order). */
export function movementReferences(movements: NormalizedHistoricalMovement[]): string[] {
  const seen = new Map<string, number>();
  return movements.map((m) => {
    const fingerprint = movementFingerprint(m);
    const occurrence = (seen.get(fingerprint) ?? 0) + 1;
    seen.set(fingerprint, occurrence);
    return ref("movement", `${fingerprint}-${occurrence}`);
  });
}

function reconcile(data: NormalizedData, issues: ValidationIssue[]): Reconciliation {
  const finalByProduct = new Map<string, number>();
  for (const p of data.products) finalByProduct.set(p.code, p.initialStock);

  // Ledger replay: opening at the registration date, then movements by (date, row).
  const ordered = [...data.movements].sort((a, b) => a.date.localeCompare(b.date) || a.source.row - b.source.row);
  for (const m of ordered) {
    const product = data.products.find((p) => p.code === m.productCode)!;
    if (m.date < product.registeredOn) {
      issues.push({ severity: "error", code: "MOVEMENT_BEFORE_REGISTRATION", message: `Movimento de ${m.productCode} anterior ao cadastro do produto.`, ...m.source });
    }
    const balance = finalByProduct.get(m.productCode)! + signedQuantity(m.type, m.quantity);
    if (balance < 0) {
      issues.push({ severity: "error", code: "NEGATIVE_BALANCE", message: `Saldo negativo de ${m.productCode} após o movimento.`, ...m.source });
    }
    finalByProduct.set(m.productCode, balance);
  }

  // The workbook's own "Estoque Atual" must agree with the replayed ledger.
  for (const p of data.products) {
    if (p.workbookCurrentStock !== finalByProduct.get(p.code)) {
      issues.push({
        severity: "error",
        code: "WORKBOOK_STOCK_MISMATCH",
        message: `${p.code}: Estoque Atual do workbook (${p.workbookCurrentStock ?? "vazio"}) ≠ ledger reconstruído (${finalByProduct.get(p.code)}).`,
        ...p.source,
      });
    }
  }

  const historicalNet = data.movements.reduce((sum, m) => sum + signedQuantity(m.type, m.quantity), 0);
  const openingQuantity = data.openingBalances.reduce((sum, o) => sum + o.quantity, 0);
  return {
    categories: data.categories.length,
    locations: data.locations.length,
    suppliers: 0,
    products: data.products.length,
    openingBalances: data.openingBalances.length,
    openingQuantity,
    historicalMovements: data.movements.length,
    historicalNet,
    finalQuantity: [...finalByProduct.values()].reduce((a, b) => a + b, 0),
    byCategory: data.categories.map((c) => {
      const products = data.products.filter((p) => p.categoryName === c.name);
      const initial = products.reduce((sum, p) => sum + p.initialStock, 0);
      const final = products.reduce((sum, p) => sum + finalByProduct.get(p.code)!, 0);
      return { name: c.name, prefix: c.prefix, initial, historicalNet: final - initial, final };
    }),
  };
}

function checkExpectations(data: NormalizedData, rec: Reconciliation, expected: ImportExpectations, issues: ValidationIssue[]) {
  const mismatch = (what: string, actual: unknown, wanted: unknown) =>
    issues.push({ severity: "error", code: "EXPECTATION_MISMATCH", message: `${what}: encontrado ${JSON.stringify(actual)}, esperado ${JSON.stringify(wanted)}.` });

  for (const [key, wanted] of Object.entries(expected.counts) as [keyof ImportExpectations["counts"], number][]) {
    if (rec[key] !== wanted) mismatch(`contagem ${key}`, rec[key], wanted);
  }
  if (rec.openingQuantity !== expected.openingQuantity) mismatch("soma dos saldos iniciais", rec.openingQuantity, expected.openingQuantity);
  if (rec.historicalNet !== expected.historicalNet) mismatch("saldo líquido histórico", rec.historicalNet, expected.historicalNet);
  if (rec.finalQuantity !== expected.finalQuantity) mismatch("quantidade final", rec.finalQuantity, expected.finalQuantity);

  const initialByCategory = Object.fromEntries(rec.byCategory.map((c) => [c.name, c.initial]));
  const names = new Set([...Object.keys(initialByCategory), ...Object.keys(expected.initialByCategory)]);
  for (const name of names) {
    if (initialByCategory[name] !== expected.initialByCategory[name]) {
      mismatch(`estoque inicial da categoria "${name}"`, initialByCategory[name] ?? null, expected.initialByCategory[name] ?? null);
    }
  }

  for (const special of expected.specialProducts) {
    const product = data.products.find((p) => p.code === special.code);
    if (!product) {
      mismatch(`produto especial ${special.code}`, null, "presente");
      continue;
    }
    if (special.initialStock !== undefined && product.initialStock !== special.initialStock) {
      mismatch(`${special.code} estoque inicial`, product.initialStock, special.initialStock);
    }
    if (special.brand !== undefined && product.brand !== special.brand) mismatch(`${special.code} marca`, product.brand, special.brand);
    if (special.model !== undefined && product.model !== special.model) mismatch(`${special.code} modelo`, product.model, special.model);
    if (special.noOpening && data.openingBalances.some((o) => o.productCode === special.code)) {
      mismatch(`${special.code} OPENING_BALANCE`, "presente", "ausente");
    }
    if (special.historical) {
      const actual = data.movements
        .filter((m) => m.productCode === special.code)
        .map((m) => ({ legacyType: m.legacyType, quantity: m.legacyQuantity, date: m.date, responsible: m.responsible }));
      if (JSON.stringify(actual) !== JSON.stringify(special.historical)) mismatch(`${special.code} movimentos históricos`, actual, special.historical);
    }
  }
}

export function buildPlan(
  data: NormalizedData,
  source: { fileName: string; sha256: string },
  expectations: ImportExpectations,
): { plan: ImportPlan | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const reconciliation = reconcile(data, issues);
  checkExpectations(data, reconciliation, expectations, issues);

  const locationRefs = data.locations.map((l) => ref("location", referenceSlug(l.code)));
  if (new Set(locationRefs).size !== locationRefs.length || locationRefs.some((r) => r.endsWith(":"))) {
    issues.push({ severity: "error", code: "REFERENCE_COLLISION", message: "Referências de localização colidem ou ficam vazias." });
  }
  if (issues.some((i) => i.severity === "error")) return { plan: null, issues };

  const categoryByName = new Map(data.categories.map((c) => [c.name, c]));
  const records: PlannedRecord[] = [];

  const categories = data.categories.map((c) => {
    const sourceReference = ref("category", c.prefix);
    records.push({
      entityType: "category",
      sourceReference,
      sourceSheet: c.source.sheet,
      sourceRow: c.source.row,
      sourceData: { name: c.name, prefix: c.prefix, description: c.description },
    });
    return { sourceReference, name: c.name, prefix: c.prefix, description: c.description };
  });

  const locations = data.locations.map((l, i) => {
    records.push({
      entityType: "location",
      sourceReference: locationRefs[i],
      sourceSheet: l.source.sheet,
      sourceRow: l.source.row,
      sourceData: { code: l.code, zone: l.zone, shelf: l.shelf, position: l.position, description: l.description },
    });
    return { sourceReference: locationRefs[i], code: l.code, zone: l.zone, shelf: l.shelf, position: l.position, description: l.description };
  });

  const products = data.products.map((p) => {
    const sourceReference = ref("product", p.code);
    records.push({
      entityType: "product",
      sourceReference,
      sourceSheet: p.source.sheet,
      sourceRow: p.source.row,
      sourceData: {
        code: p.code,
        category: p.categoryName,
        brand: p.brand,
        model: p.model,
        specification: p.specification,
        unit: p.unit,
        initial_stock: p.initialStock,
        minimum_stock: p.minimumStock,
        location: p.locationCode,
        active: p.active,
        registered_on: p.registeredOn,
        legacy_qr: p.legacyQr,
        notes: p.notes,
      },
    });
    return {
      sourceReference,
      code: p.code,
      categoryPrefix: categoryByName.get(p.categoryName)!.prefix,
      brand: p.brand,
      model: p.model,
      specification: p.specification,
      unit: p.unit,
      minimumStock: p.minimumStock,
      locationCode: p.locationCode,
      active: p.active,
      qrCode: null,
      createdAt: dayStartInLisbon(p.registeredOn),
    };
  });

  const movements: PlannedMovement[] = data.openingBalances.map((o) => {
    const sourceReference = ref("opening", o.productCode);
    records.push({
      entityType: "stock_movement",
      sourceReference,
      sourceSheet: o.source.sheet,
      sourceRow: o.source.row,
      sourceData: { product_code: o.productCode, quantity: o.quantity, date: o.date, origin: "Estoque Inicial", sheet: o.source.sheet, row: o.source.row },
    });
    return { sourceReference, productCode: o.productCode, type: "OPENING_BALANCE", quantity: o.quantity, createdAt: dayStartInLisbon(o.date), documentReference: null, notes: null, kind: "opening" };
  });

  const historicalRefs = movementReferences(data.movements);
  data.movements.forEach((m, i) => {
    records.push({
      entityType: "stock_movement",
      sourceReference: historicalRefs[i],
      sourceSheet: m.source.sheet,
      sourceRow: m.source.row,
      sourceData: {
        date: m.date,
        type: m.legacyType,
        code: m.productCode,
        quantity: m.legacyQuantity,
        responsible: m.responsible,
        project: m.project,
        document: m.document,
        notes: m.notes,
        sheet: m.source.sheet,
        row: m.source.row,
      },
    });
    movements.push({
      sourceReference: historicalRefs[i],
      productCode: m.productCode,
      type: m.type,
      quantity: m.quantity,
      createdAt: dayStartInLisbon(m.date),
      documentReference: m.document,
      notes: m.notes,
      kind: "historical",
    });
  });

  const refs = records.map((r) => `${r.entityType}|${r.sourceReference}`);
  if (new Set(refs).size !== refs.length) {
    issues.push({ severity: "error", code: "REFERENCE_COLLISION", message: "Referências de origem duplicadas no plano." });
    return { plan: null, issues };
  }

  return {
    plan: {
      source: { fileName: source.fileName, sha256: source.sha256, importVersion: IMPORT_VERSION },
      executedByEmail: EXECUTED_BY_EMAIL,
      categories,
      locations,
      products,
      movements,
      records,
      reconciliation,
    },
    issues,
  };
}

