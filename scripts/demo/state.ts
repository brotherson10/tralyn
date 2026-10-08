/**
 * VISUAL DEMO STATE: the exact local database state after `npm run demo:setup`
 * (canonical demo import + the fictional layer in ./data.ts). Measured and
 * pinned; separate from the canonical import state, which stays
 * CANONICAL_DB_EXPECTATIONS (345 units, 7 OK / 3 REORDER / 2 OUT_OF_STOCK).
 */
export interface DemoState {
  counts: {
    categories: number;
    locations: number;
    suppliers: number;
    projects: number;
    products: number;
    productsWithSupplier: number;
    stockMovements: number;
    projectMovements: number;
    importBatches: number;
    importRecords: number;
  };
  projectsByStatus: Record<string, number>;
  users: { email: string; name: string; role: string; active: boolean }[];
  movementsByType: Record<string, { count: number; quantity: number }>;
  movementsByUser: Record<string, number>;
  totalStock: number;
  statusCounts: { OUT_OF_STOCK: number; REORDER: number; OK: number };
  balances: Record<string, number>;
  minBalance: number;
}

export const DEMO_VISUAL_STATE: DemoState = {
  counts: {
    categories: 5,
    locations: 3,
    suppliers: 2,
    projects: 3,
    products: 12,
    productsWithSupplier: 4,
    stockMovements: 21,
    projectMovements: 3,
    importBatches: 1,
    importRecords: 35,
  },
  projectsByStatus: { active: 1, completed: 1, cancelled: 1 },
  users: [
    { email: "admin.demo@tralyn.test", name: "Admin Demo", role: "admin", active: true },
    { email: "importacao@tralyn.invalid", name: "Importação de dados", role: "viewer", active: false },
    { email: "operator.demo@tralyn.test", name: "Operator Demo", role: "operator", active: true },
    { email: "viewer.demo@tralyn.test", name: "Viewer Demo", role: "viewer", active: true },
  ],
  movementsByType: {
    OPENING_BALANCE: { count: 10, quantity: 343 },
    IN: { count: 3, quantity: 17 },
    OUT: { count: 4, quantity: 32 },
    ADJUSTMENT_IN: { count: 2, quantity: 6 },
    ADJUSTMENT_OUT: { count: 2, quantity: 4 },
  },
  movementsByUser: { "Importação de dados": 15, "Operator Demo": 4, "Admin Demo": 2 },
  totalStock: 330,
  statusCounts: { OUT_OF_STOCK: 2, REORDER: 4, OK: 6 },
  balances: {
    "BAT-301": 20,
    "BAT-302": 0,
    "EVC-401": 2,
    "EVC-402": 0,
    "INV-201": 4,
    "INV-202": 3,
    "MNT-501": 62,
    "MNT-502": 125,
    "MNT-503": 5,
    "MNT-504": 75,
    "PAN-101": 28,
    "PAN-102": 6,
  },
  minBalance: 0,
};
