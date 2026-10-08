import { z } from "zod";
import type { Database } from "@/types/database";

/**
 * Validation for master data forms (categories, locations, suppliers,
 * projects). Always applied on the server; database constraints remain the
 * final guard. Empty optional fields are stored as NULL.
 */

/** Collapses internal whitespace and trims. */
const clean = (value: string) => value.replace(/\s+/g, " ").trim();

const requiredText = (label: string, max: number) =>
  z
    .string({ error: `Indique ${label}.` })
    .transform(clean)
    .pipe(z.string().min(1, `Indique ${label}.`).max(max, `Máximo de ${max} caracteres.`));

const optionalText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : clean(value) || null))
    .pipe(z.string().max(max, `Máximo de ${max} caracteres.`).nullable());

/** Multi-line text: keeps line breaks, trims the ends. */
const optionalLongText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : value.replace(/\r\n/g, "\n").trim() || null))
    .pipe(z.string().max(max, `Máximo de ${max} caracteres.`).nullable());

// -----------------------------------------------------------------------------
// Categories
// -----------------------------------------------------------------------------
export const categorySchema = z.object({
  name: requiredText("o nome", 60),
  prefix: z
    .string({ error: "Indique o prefixo." })
    .transform((value) => value.trim().toUpperCase())
    .pipe(
      z
        .string()
        .min(1, "Indique o prefixo.")
        .regex(/^[A-Z0-9]{2,10}$/, "Use 2 a 10 letras ou números, sem espaços nem acentos (ex.: INV)."),
    ),
  description: optionalText(300),
});
export type CategoryInput = z.infer<typeof categorySchema>;

// -----------------------------------------------------------------------------
// Locations
// -----------------------------------------------------------------------------
export const locationSchema = z.object({
  code: requiredText("o código", 40),
  zone: optionalText(40),
  shelf: optionalText(20),
  position: optionalText(20),
  description: optionalText(300),
});
export type LocationInput = z.infer<typeof locationSchema>;

// -----------------------------------------------------------------------------
// Suppliers
// -----------------------------------------------------------------------------
export const supplierSchema = z.object({
  name: requiredText("o nome", 120),
  email: z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : value.trim().toLowerCase() || null))
    .pipe(z.email("Indique um email válido.").max(254, "Email demasiado longo.").nullable()),
  phone: optionalText(30).pipe(
    z
      .string()
      .regex(/^\+?[0-9][0-9 ().-]{5,28}$/, "Indique um telefone válido (apenas números, espaços, +, -, parênteses).")
      .nullable(),
  ),
  contact_person: optionalText(120),
  notes: optionalLongText(1000),
});
export type SupplierInput = z.infer<typeof supplierSchema>;

// -----------------------------------------------------------------------------
// Projects
// -----------------------------------------------------------------------------
export type ProjectStatus = Database["public"]["Enums"]["project_status"];
export const PROJECT_STATUSES = ["active", "completed", "cancelled"] as const satisfies readonly ProjectStatus[];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  active: "Ativo",
  completed: "Concluído",
  cancelled: "Cancelado",
};

export const projectSchema = z.object({
  name: requiredText("o nome", 120),
  client: optionalText(120),
  reference: optionalText(60),
  status: z.enum(PROJECT_STATUSES, { error: "Escolha um estado válido." }),
  notes: optionalLongText(1000),
});
export type ProjectInput = z.infer<typeof projectSchema>;

// -----------------------------------------------------------------------------
// List filters (from the URL query string)
// -----------------------------------------------------------------------------
export const ACTIVE_FILTERS = ["todos", "ativos", "inativos"] as const;
export type ActiveFilter = (typeof ACTIVE_FILTERS)[number];

export function parseActiveFilter(value: unknown): ActiveFilter {
  return (ACTIVE_FILTERS as readonly unknown[]).includes(value) ? (value as ActiveFilter) : "todos";
}

export function parseProjectStatusFilter(value: unknown): ProjectStatus | "todos" {
  return (PROJECT_STATUSES as readonly unknown[]).includes(value) ? (value as ProjectStatus) : "todos";
}

/**
 * Normalizes free-text search for PostgREST filters: removes characters with
 * special meaning in `or=(...)` / LIKE patterns and limits the length.
 */
export function sanitizeSearch(value: unknown): string {
  if (typeof value !== "string") return "";
  return clean(value.replace(/[,()%*_\\"']/g, " ")).slice(0, 80);
}
