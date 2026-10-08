/**
 * Fictional data layered on top of the canonical demo import to make the
 * LOCAL demo environment useful for visual review. Everything here is
 * public-safe: reserved domains (.test / .example), invented names, no real
 * people, brands or company data.
 *
 * The canonical import state (CANONICAL_DB_EXPECTATIONS) is never changed by
 * this module; DEMO_VISUAL_STATE is the separate end state after the extra
 * operational movements below.
 */
import type { OperationalMovementType } from "@/lib/stock/ledger";
import type { ProjectStatus } from "@/validation/master-data";

export type DemoRole = "admin" | "operator" | "viewer";

/**
 * LOCAL-ONLY demo password, deliberately non-sensitive and public. It must
 * never be used for any real or hosted account.
 */
export const DEMO_PASSWORD = "tralyn-demo-2026";

export const DEMO_USERS: { key: DemoRole; name: string; email: string; role: DemoRole }[] = [
  { key: "admin", name: "Admin Demo", email: "admin.demo@tralyn.test", role: "admin" },
  { key: "operator", name: "Operator Demo", email: "operator.demo@tralyn.test", role: "operator" },
  { key: "viewer", name: "Viewer Demo", email: "viewer.demo@tralyn.test", role: "viewer" },
];

export const DEMO_SUPPLIERS = [
  {
    name: "Sunvolt Supply",
    email: "orders@sunvolt-supply.example",
    phone: null,
    contact_person: "Equipa comercial",
    notes: "Fornecedor fictício (demo) de painéis solares.",
  },
  {
    name: "Northgrid Components",
    email: "sales@northgrid-components.example",
    phone: null,
    contact_person: "Gestão de conta",
    notes: "Fornecedor fictício (demo) de carregadores VE.",
  },
] as const;

/** Default supplier per product code (existing products.default_supplier_id). */
export const DEMO_SUPPLIER_LINKS: Record<string, (typeof DEMO_SUPPLIERS)[number]["name"]> = {
  "PAN-101": "Sunvolt Supply",
  "PAN-102": "Sunvolt Supply",
  "EVC-401": "Northgrid Components",
  "EVC-402": "Northgrid Components",
};

/** Projects are created active (movements need an active project), then moved to `finalStatus`. */
export const DEMO_PROJECTS: { name: string; client: string; reference: string; notes: string; finalStatus: ProjectStatus }[] = [
  {
    name: "Residential Rooftop 6 kWp",
    client: "Cliente residencial (demo)",
    reference: "DEMO-P-001",
    notes: "Instalação fotovoltaica residencial fictícia.",
    finalStatus: "active",
  },
  {
    name: "Commercial Carport",
    client: "Retail park (demo)",
    reference: "DEMO-P-002",
    notes: "Cobertura de estacionamento com carregadores VE (fictício).",
    finalStatus: "completed",
  },
  {
    name: "Battery Retrofit",
    client: "Cliente agrícola (demo)",
    reference: "DEMO-P-003",
    notes: "Retrofit de baterias cancelado pelo cliente (fictício).",
    finalStatus: "cancelled",
  },
];

/** Operational movements, registered through the RPC by the demo users (never inserted into the ledger directly). */
export const DEMO_OPERATIONS: {
  actor: Exclude<DemoRole, "viewer">;
  code: string;
  type: OperationalMovementType;
  quantity: number;
  project: string | null;
  document: string | null;
  notes: string | null;
}[] = [
  { actor: "operator", code: "BAT-301", type: "IN", quantity: 6, project: null, document: "DEMO-GR-0102", notes: null },
  { actor: "operator", code: "PAN-101", type: "OUT", quantity: 14, project: "Residential Rooftop 6 kWp", document: "DEMO-REQ-0201", notes: null },
  { actor: "operator", code: "INV-201", type: "OUT", quantity: 1, project: "Residential Rooftop 6 kWp", document: "DEMO-REQ-0201", notes: null },
  { actor: "operator", code: "EVC-401", type: "OUT", quantity: 5, project: "Commercial Carport", document: "DEMO-REQ-0301", notes: null },
  { actor: "admin", code: "MNT-503", type: "ADJUSTMENT_IN", quantity: 1, project: null, document: null, notes: "Contagem física: 1 unidade não registada." },
  { actor: "admin", code: "MNT-501", type: "ADJUSTMENT_OUT", quantity: 2, project: null, document: null, notes: "Contagem física: 2 calhas danificadas." },
];
