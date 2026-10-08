/**
 * Stock ledger domain rules.
 *
 * Stock is never stored as an editable number: it is always derived from the
 * movement history. Quantities are always positive; the movement type alone
 * defines the effect on the balance. The same rules are enforced in
 * PostgreSQL (view + RPC); this module mirrors them for the UI and for tests.
 */

export const MOVEMENT_TYPES = [
  "OPENING_BALANCE",
  "IN",
  "OUT",
  "ADJUSTMENT_IN",
  "ADJUSTMENT_OUT",
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  OPENING_BALANCE: "Saldo inicial",
  IN: "Entrada",
  OUT: "Saída",
  ADJUSTMENT_IN: "Ajuste +",
  ADJUSTMENT_OUT: "Ajuste -",
};

/**
 * Types offered by the operational UI. OPENING_BALANCE is reserved for the
 * initial inventory import and is never offered in forms (the database still
 * accepts it from admins, which the importer needs).
 */
export const OPERATIONAL_MOVEMENT_TYPES = ["IN", "OUT", "ADJUSTMENT_IN", "ADJUSTMENT_OUT"] as const satisfies readonly MovementType[];
export type OperationalMovementType = (typeof OPERATIONAL_MOVEMENT_TYPES)[number];

export function isAdjustment(type: MovementType): boolean {
  return type === "ADJUSTMENT_IN" || type === "ADJUSTMENT_OUT";
}

const SIGN: Record<MovementType, 1 | -1> = {
  OPENING_BALANCE: 1,
  IN: 1,
  ADJUSTMENT_IN: 1,
  OUT: -1,
  ADJUSTMENT_OUT: -1,
};

export function isMovementType(value: unknown): value is MovementType {
  return typeof value === "string" && (MOVEMENT_TYPES as readonly string[]).includes(value);
}

export function isOutbound(type: MovementType): boolean {
  return SIGN[type] === -1;
}

/** Signed effect of a single movement on the balance. */
export function signedQuantity(type: MovementType, quantity: number): number {
  assertValidQuantity(quantity);
  return SIGN[type] * quantity;
}

export interface LedgerEntry {
  type: MovementType;
  quantity: number;
}

/**
 * saldo = OPENING_BALANCE + IN + ADJUSTMENT_IN − OUT − ADJUSTMENT_OUT
 */
export function computeBalance(entries: Iterable<LedgerEntry>): number {
  let balance = 0;
  for (const entry of entries) {
    balance += signedQuantity(entry.type, entry.quantity);
  }
  return balance;
}

export type MovementCheck =
  | { ok: true; resultingBalance: number }
  | { ok: false; reason: "INVALID_QUANTITY" | "INSUFFICIENT_STOCK"; available: number };

/**
 * Checks whether a movement may be applied on top of the current balance.
 * Outbound movements may never leave the balance negative.
 */
export function checkMovement(
  currentBalance: number,
  type: MovementType,
  quantity: number,
): MovementCheck {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, reason: "INVALID_QUANTITY", available: currentBalance };
  }
  const resultingBalance = currentBalance + SIGN[type] * quantity;
  if (isOutbound(type) && resultingBalance < 0) {
    return { ok: false, reason: "INSUFFICIENT_STOCK", available: currentBalance };
  }
  return { ok: true, resultingBalance };
}

function assertValidQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new RangeError(`Movement quantity must be a positive integer, got ${quantity}`);
  }
}
