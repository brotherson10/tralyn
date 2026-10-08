/**
 * Writes the public demo workbook (100% fictional data) to
 * CANONICAL_WORKBOOK_PATH. Deterministic: the same module always produces the
 * same bytes, so the SHA-256 in CANONICAL_EXPECTATIONS stays valid.
 *
 *   npm run inventory:demo-workbook
 *
 * Exit: 0 written (prints path and SHA-256 only).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildDemoWorkbook } from "./inventory-import/demo-workbook";
import { CANONICAL_WORKBOOK_PATH } from "./inventory-import/expectations";
import { sha256Hex } from "./inventory-import/pipeline";

const bytes = buildDemoWorkbook();
mkdirSync(dirname(CANONICAL_WORKBOOK_PATH), { recursive: true });
writeFileSync(CANONICAL_WORKBOOK_PATH, bytes);
console.log(JSON.stringify({ path: CANONICAL_WORKBOOK_PATH, bytes: bytes.length, sha256: sha256Hex(bytes) }, null, 2));
