import { z } from "zod";
import { MOVEMENT_TYPES, OPERATIONAL_MOVEMENT_TYPES, isAdjustment, type MovementType } from "@/lib/stock/ledger";

/**
 * Validation for the operational movement form. It mirrors the parameters of
 * public.register_stock_movement; the RPC remains the authority (permissions,
 * active product/project, non-negative balance, concurrency).
 *
 * There is deliberately no user, date or balance field: the responsible user
 * and the timestamp come from the database session.
 */

const optionalText = (max: number) =>
  z
    .string()
    .nullish()
    .transform((value) => (value == null ? null : value.replace(/\r\n/g, "\n").trim() || null))
    .pipe(z.string().max(max, `Máximo de ${max} caracteres.`).nullable());

export const movementSchema = z
  .object({
    product_id: z
      .string({ error: "Escolha o produto." })
      .trim()
      .min(1, "Escolha o produto.")
      .pipe(z.uuid("Escolha um produto válido.")),
    type: z.enum(OPERATIONAL_MOVEMENT_TYPES, { error: "Escolha o tipo de movimentação." }),
    // Always a positive integer; the type defines the effect on the balance.
    quantity: z
      .string({ error: "Indique a quantidade." })
      .trim()
      .min(1, "Indique a quantidade.")
      .regex(/^-?\d+$/, "Indique um número inteiro, sem casas decimais.")
      .transform(Number)
      .pipe(
        z
          .number()
          .int()
          .positive("A quantidade tem de ser maior que zero. O tipo define se é entrada ou saída.")
          .max(1_000_000, "Quantidade demasiado alta."),
      ),
    project_id: z
      .string()
      .nullish()
      .transform((value) => (value == null || value.trim() === "" ? null : value.trim()))
      .pipe(z.uuid("Escolha um projeto válido.").nullable()),
    document_reference: optionalText(120),
    notes: optionalText(1000),
  })
  .superRefine((value, ctx) => {
    if (isAdjustment(value.type) && !value.notes) {
      ctx.addIssue({
        code: "custom",
        path: ["notes"],
        message: "Nos ajustes, explique o motivo nas observações (ex.: resultado da contagem física).",
      });
    }
  });

export type MovementInput = z.output<typeof movementSchema>;

// -----------------------------------------------------------------------------
// History filters (URL query string)
// -----------------------------------------------------------------------------
export const MOVEMENTS_PAGE_SIZE = 50;

export interface MovementFilters {
  q: string;
  type: MovementType | null;
  productId: string | null;
  projectId: string | null;
  /** Inclusive local dates (YYYY-MM-DD, Europe/Lisbon). */
  from: string | null;
  to: string | null;
  page: number;
}

const uuid = z.uuid();
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !isoDate.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : value;
}

export function parseMovementFilters(
  params: Record<string, unknown>,
  sanitize: (value: unknown) => string,
): MovementFilters {
  const page = Number(params.pagina);
  return {
    q: sanitize(params.q),
    type: (MOVEMENT_TYPES as readonly unknown[]).includes(params.tipo) ? (params.tipo as MovementType) : null,
    productId: uuid.safeParse(params.produto).success ? (params.produto as string) : null,
    projectId: uuid.safeParse(params.projeto).success ? (params.projeto as string) : null,
    from: validDate(params.de),
    to: validDate(params.ate),
    page: Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/**
 * UTC instant at which a local day starts in Europe/Lisbon (handles WET/WEST).
 * `dayStartInLisbon("2026-07-28")` → "2026-07-27T23:00:00.000Z" (summer time).
 */
export function dayStartInLisbon(date: string): string {
  const utcMidnight = new Date(`${date}T00:00:00Z`);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Lisbon",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(utcMidnight);
  const lisbonHourAtUtcMidnight = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  return new Date(utcMidnight.getTime() - lisbonHourAtUtcMidnight * 3_600_000).toISOString();
}

/** Start of the day after `date` in Lisbon (exclusive upper bound for "até"). */
export function nextDayStartInLisbon(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return dayStartInLisbon(next.toISOString().slice(0, 10));
}
