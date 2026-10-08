/**
 * PARSED → NORMALIZED. Strings are NFC + trimmed and blanks become NULL;
 * everything else is checked strictly (no type coercion, no invented
 * values). Each problem becomes a ValidationIssue pointing at sheet/row/column.
 */
import type { ImportExpectations } from "./expectations";
import type {
  LegacyMovementType,
  NormalizedCategory,
  NormalizedData,
  NormalizedHistoricalMovement,
  NormalizedLocation,
  NormalizedProduct,
  ParsedRow,
  ParsedWorkbook,
  RawCell,
  ValidationIssue,
} from "./model";
import type { MovementType } from "@/lib/stock/ledger";

const CATEGORY_PREFIX = /^[A-Z0-9]{2,10}$/;
const PRODUCT_CODE = /^([A-Z0-9]{2,10})-(\d{3})$/;
/** Same limits as the stock_movements check constraints. */
const DOCUMENT_MAX = 120;
const NOTES_MAX = 1000;

class RowReader<F extends string> {
  constructor(
    private readonly parsed: ParsedRow<F>,
    private readonly issues: ValidationIssue[],
  ) {}

  private issue(code: string, message: string, column: F, severity: ValidationIssue["severity"] = "error") {
    this.issues.push({ severity, code, message, sheet: this.parsed.sheet, row: this.parsed.row, column });
  }

  private cell(field: F): RawCell | null {
    return this.parsed.fields[field] ?? null;
  }

  /** Text or NULL. Numbers/booleans/errors in a text column are rejected (no coercion). */
  text(field: F, label: string): string | null {
    const cell = this.cell(field);
    if (!cell || cell.type === "z" || cell.value === null) return null;
    if (cell.type === "e") {
      this.issue("CELL_ERROR", `${label}: célula com erro ${String(cell.value)}.`, field);
      return null;
    }
    if (cell.type !== "s" || typeof cell.value !== "string") {
      this.issue("TEXT_EXPECTED", `${label}: esperado texto.`, field);
      return null;
    }
    const normalized = cell.value.normalize("NFC").trim();
    return normalized === "" ? null : normalized;
  }

  requiredText(field: F, label: string, code: string): string | null {
    const value = this.text(field, label);
    if (value === null && !this.issues.some((i) => i.row === this.parsed.row && i.column === field && i.sheet === this.parsed.sheet)) {
      this.issue(code, `${label} em falta.`, field);
    }
    return value;
  }

  /** Integer number cell (no text-to-number coercion). */
  integer(field: F, label: string, code: string): number | null {
    const cell = this.cell(field);
    if (!cell || cell.type === "z" || cell.value === null || cell.value === "") {
      this.issue(code, `${label} em falta.`, field);
      return null;
    }
    if (cell.type !== "n" || typeof cell.value !== "number" || !Number.isInteger(cell.value)) {
      this.issue(code, `${label}: esperado número inteiro.`, field);
      return null;
    }
    return cell.value;
  }

  /** Excel 1900-system date serial without time → YYYY-MM-DD. */
  date(field: F, label: string, code: string): string | null {
    const cell = this.cell(field);
    if (!cell || cell.type !== "n" || typeof cell.value !== "number") {
      this.issue(code, `${label}: esperado uma data.`, field);
      return null;
    }
    if (!Number.isInteger(cell.value) || cell.value < 61) {
      this.issue(code, `${label}: data com hora ou fora do intervalo suportado.`, field);
      return null;
    }
    return new Date(Date.UTC(1899, 11, 30) + cell.value * 86_400_000).toISOString().slice(0, 10);
  }

  yesNo(field: F, label: string): boolean | null {
    const value = this.text(field, label);
    if (value === "Sim") return true;
    if (value === "Não") return false;
    this.issue("BOOLEAN_INVALID", `${label}: esperado "Sim" ou "Não".`, field);
    return null;
  }

  /** Cached formula result: number or NULL (cross-checks only). */
  derivedNumber(field: F): number | null {
    const cell = this.cell(field);
    return cell && cell.type === "n" && typeof cell.value === "number" ? cell.value : null;
  }

  rawExactText(field: F): string | null {
    const cell = this.cell(field);
    return cell && cell.type === "s" && typeof cell.value === "string" ? cell.value : null;
  }

  get source() {
    return { sheet: this.parsed.sheet, row: this.parsed.row };
  }

  fail(code: string, message: string, column: F, severity: ValidationIssue["severity"] = "error") {
    this.issue(code, message, column, severity);
  }
}

const fold = (value: string) => value.toLocaleLowerCase("pt-PT");

function normalizeCategories(rows: ParsedWorkbook["categories"], issues: ValidationIssue[]): NormalizedCategory[] {
  const result: NormalizedCategory[] = [];
  for (const parsed of rows) {
    const r = new RowReader(parsed, issues);
    const before = issues.length;
    const name = r.requiredText("name", "Categoria", "CATEGORY_NAME_MISSING");
    const prefix = r.requiredText("prefix", "Prefixo", "CATEGORY_PREFIX_MISSING");
    const description = r.text("description", "Descrição");
    if (prefix !== null && !CATEGORY_PREFIX.test(prefix)) r.fail("CATEGORY_PREFIX_INVALID", `Prefixo "${prefix}" inválido.`, "prefix");
    if (name !== null && result.some((c) => fold(c.name) === fold(name))) r.fail("CATEGORY_DUPLICATE", `Categoria "${name}" duplicada.`, "name");
    if (prefix !== null && result.some((c) => c.prefix === prefix)) r.fail("CATEGORY_PREFIX_DUPLICATE", `Prefixo "${prefix}" duplicado.`, "prefix");
    if (issues.length === before && name !== null && prefix !== null) result.push({ name, prefix, description, source: r.source });
  }
  return result;
}

function normalizeLocations(
  rows: ParsedWorkbook["locations"],
  expectations: ImportExpectations,
  issues: ValidationIssue[],
): { real: NormalizedLocation[]; excluded: NormalizedData["excludedLocations"] } {
  const real: NormalizedLocation[] = [];
  const excluded: NormalizedData["excludedLocations"] = [];
  const seen = new Set<string>();
  for (const parsed of rows) {
    const r = new RowReader(parsed, issues);
    const before = issues.length;
    const location: NormalizedLocation = {
      code: r.requiredText("code", "Código", "LOCATION_CODE_MISSING") ?? "",
      zone: r.text("zone", "Estante / Zona"),
      shelf: r.text("shelf", "Prateleira"),
      position: r.text("position", "Posição"),
      description: r.text("description", "Descrição"),
      source: r.source,
    };
    if (issues.length !== before) continue;
    if (seen.has(fold(location.code))) {
      r.fail("LOCATION_DUPLICATE", `Localização "${location.code}" duplicada.`, "code");
      continue;
    }
    seen.add(fold(location.code));
    const exclusion = expectations.excludedLocations.find((e) => e.code === location.code);
    if (exclusion) {
      excluded.push({ ...location, reason: exclusion.reason });
      r.fail("LOCATION_EXCLUDED", `Localização "${location.code}" ignorada: ${exclusion.reason}.`, "code", "warning");
    } else if (expectations.realLocations.includes(location.code)) {
      real.push(location);
    } else {
      r.fail("LOCATION_UNEXPECTED", `Localização "${location.code}" não prevista (nem real, nem exemplo conhecido).`, "code");
    }
  }
  for (const code of expectations.realLocations) {
    if (!real.some((l) => l.code === code)) {
      issues.push({ severity: "error", code: "LOCATION_MISSING", message: `Localização real "${code}" não encontrada.` });
    }
  }
  return { real, excluded };
}

function normalizeProducts(
  rows: ParsedWorkbook["products"],
  categories: NormalizedCategory[],
  locations: NormalizedLocation[],
  excluded: NormalizedData["excludedLocations"],
  issues: ValidationIssue[],
): NormalizedProduct[] {
  const result: NormalizedProduct[] = [];
  for (const parsed of rows) {
    const r = new RowReader(parsed, issues);
    const before = issues.length;

    const rawCode = r.rawExactText("code");
    const code = r.requiredText("code", "Código", "PRODUCT_CODE_MISSING");
    const match = code === null ? null : PRODUCT_CODE.exec(code);
    if (code !== null && (rawCode !== code || !match)) r.fail("PRODUCT_CODE_INVALID", `Código "${code}" inválido.`, "code");
    if (code !== null && result.some((p) => p.code === code)) r.fail("PRODUCT_DUPLICATE", `Código "${code}" duplicado.`, "code");

    const categoryName = r.requiredText("category", "Categoria", "PRODUCT_CATEGORY_MISSING");
    const category = categoryName === null ? undefined : categories.find((c) => c.name === categoryName);
    if (categoryName !== null && !category) r.fail("CATEGORY_UNKNOWN", `Categoria "${categoryName}" inexistente.`, "category");
    if (category && match && match[1] !== category.prefix) {
      r.fail("PRODUCT_CODE_PREFIX_MISMATCH", `Código "${code}" não usa o prefixo ${category.prefix} da categoria.`, "code");
    }

    const brand = r.text("brand", "Marca");
    const model = r.text("model", "Modelo / Produto");
    const specification = r.text("specification", "Especificação");
    if (brand === null && model === null) r.fail("PRODUCT_UNIDENTIFIED", "Produto sem marca nem modelo.", "model");
    const unit = r.requiredText("unit", "Unidade", "PRODUCT_UNIT_MISSING");

    const initialStock = r.integer("initialStock", "Estoque Inicial", "INITIAL_STOCK_INVALID");
    if (initialStock !== null && initialStock < 0) r.fail("INITIAL_STOCK_NEGATIVE", "Estoque Inicial negativo.", "initialStock");
    const minimumStock = r.integer("minimumStock", "Estoque Mínimo", "MINIMUM_STOCK_INVALID");
    if (minimumStock !== null && minimumStock < 0) r.fail("MINIMUM_STOCK_INVALID", "Estoque Mínimo negativo.", "minimumStock");

    const locationCode = r.requiredText("location", "Localização", "PRODUCT_LOCATION_MISSING");
    if (locationCode !== null && !locations.some((l) => l.code === locationCode)) {
      const isExample = excluded.some((l) => l.code === locationCode);
      r.fail(
        isExample ? "LOCATION_EXCLUDED_REFERENCED" : "LOCATION_UNKNOWN",
        isExample ? `Produto usa a localização de exemplo "${locationCode}".` : `Localização "${locationCode}" inexistente.`,
        "location",
      );
    }
    if (r.text("supplier", "Fornecedor Padrão") !== null) {
      r.fail("SUPPLIER_UNSUPPORTED", "Fornecedor indicado, mas esta importação não cria fornecedores.", "supplier");
    }

    const legacyQr = r.text("legacyQr", "ID QR / Barcode");
    const active = r.yesNo("active", "Ativo?");
    const registeredOn = r.date("registeredOn", "Data Cadastro Sistema", "REGISTERED_ON_INVALID");
    const notes = r.text("notes", "Observações");

    if (issues.length !== before) continue;
    if (legacyQr !== null && legacyQr !== code) {
      r.fail("LEGACY_QR_DIFFERS", `ID QR legado "${legacyQr}" difere do código (preservado só em source_data).`, "legacyQr", "warning");
    }
    if (notes !== null) {
      r.fail("NOTES_PROVENANCE_ONLY", "Observações preservadas apenas em source_data (sem coluna em products).", "notes", "warning");
    }
    result.push({
      code: code!,
      categoryName: categoryName!,
      brand,
      model,
      specification,
      unit: unit!,
      initialStock: initialStock!,
      minimumStock: minimumStock!,
      locationCode: locationCode!,
      active: active!,
      registeredOn: registeredOn!,
      legacyQr,
      notes,
      workbookCurrentStock: r.derivedNumber("workbookCurrentStock"),
      source: r.source,
    });
  }
  return result;
}

const LEGACY_TYPES: Record<string, LegacyMovementType> = { Entrada: "Entrada", Saída: "Saída", Ajuste: "Ajuste" };

function normalizeMovements(
  rows: ParsedWorkbook["movements"],
  products: NormalizedProduct[],
  issues: ValidationIssue[],
): NormalizedHistoricalMovement[] {
  const result: NormalizedHistoricalMovement[] = [];
  for (const parsed of rows) {
    const r = new RowReader(parsed, issues);
    const before = issues.length;

    const date = r.date("date", "Data", "MOVEMENT_DATE_INVALID");
    const typeText = r.requiredText("type", "Tipo", "MOVEMENT_TYPE_MISSING");
    const legacyType = typeText === null ? undefined : LEGACY_TYPES[typeText];
    if (typeText !== null && !legacyType) r.fail("MOVEMENT_TYPE_UNKNOWN", `Tipo de movimento "${typeText}" desconhecido.`, "type");

    const productCode = r.requiredText("code", "Código", "MOVEMENT_PRODUCT_MISSING");
    const product = productCode === null ? undefined : products.find((p) => p.code === productCode);
    if (productCode !== null && !product) r.fail("MOVEMENT_PRODUCT_UNKNOWN", `Movimento para produto inexistente "${productCode}".`, "code");

    const legacyQuantity = r.integer("quantity", "Quantidade", "MOVEMENT_QUANTITY_INVALID");
    let type: MovementType | null = null;
    if (legacyType && legacyQuantity !== null) {
      if (legacyType === "Ajuste") {
        if (legacyQuantity === 0) r.fail("MOVEMENT_QUANTITY_INVALID", "Ajuste com quantidade 0.", "quantity");
        else type = legacyQuantity > 0 ? "ADJUSTMENT_IN" : "ADJUSTMENT_OUT";
      } else if (legacyQuantity <= 0) {
        r.fail("MOVEMENT_QUANTITY_INVALID", `${legacyType} exige quantidade positiva.`, "quantity");
      } else {
        type = legacyType === "Entrada" ? "IN" : "OUT";
      }
    }

    const project = r.text("project", "Projeto / Cliente");
    if (project !== null) r.fail("PROJECT_UNSUPPORTED", "Movimento com projeto: esta importação não cria projetos.", "project");
    const responsible = r.text("responsible", "Responsável");
    const document = r.text("document", "Documento / Ref.");
    if (document !== null && document.length > DOCUMENT_MAX) r.fail("DOCUMENT_TOO_LONG", `Documento com mais de ${DOCUMENT_MAX} caracteres.`, "document");
    const notes = r.text("notes", "Observação");
    if (notes !== null && notes.length > NOTES_MAX) r.fail("NOTES_TOO_LONG", `Observação com mais de ${NOTES_MAX} caracteres.`, "notes");

    // The workbook's own lookups must agree with the product it references.
    const workbookCategory = r.text("category", "Categoria");
    const workbookProduct = r.text("product", "Produto / Modelo");
    if (product && (workbookCategory !== product.categoryName || workbookProduct !== product.model)) {
      r.fail("WORKBOOK_LOOKUP_MISMATCH", "Categoria/Produto do movimento não coincidem com PRODUTOS.", "category");
    }

    if (issues.length !== before) continue;
    result.push({
      date: date!,
      legacyType: legacyType!,
      type: type!,
      productCode: productCode!,
      quantity: Math.abs(legacyQuantity!),
      legacyQuantity: legacyQuantity!,
      responsible,
      project,
      document,
      notes,
      workbookCategory,
      workbookProduct,
      source: r.source,
    });
  }
  return result;
}

export function normalize(parsed: ParsedWorkbook, expectations: ImportExpectations): { data: NormalizedData; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const categories = normalizeCategories(parsed.categories, issues);
  const { real, excluded } = normalizeLocations(parsed.locations, expectations, issues);
  const products = normalizeProducts(parsed.products, categories, real, excluded, issues);
  const movements = normalizeMovements(parsed.movements, products, issues);
  const openingBalances = products
    .filter((p) => p.initialStock > 0)
    .map((p) => ({ productCode: p.code, quantity: p.initialStock, date: p.registeredOn, source: p.source }));
  return { data: { categories, locations: real, excludedLocations: excluded, products, openingBalances, movements }, issues };
}
