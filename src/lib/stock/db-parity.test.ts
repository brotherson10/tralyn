import { describe, expectTypeOf, it } from "vitest";
import type { Database } from "@/types/database";
import type { MovementType } from "./ledger";
import type { StockStatus } from "./status";

type Enums = Database["public"]["Enums"];

/** Fails type-checking if the TypeScript domain and the PostgreSQL enums drift apart. */
describe("TypeScript domain matches the database enums", () => {
  it("movement types", () => {
    expectTypeOf<MovementType>().toEqualTypeOf<Enums["movement_type"]>();
  });
  it("stock statuses", () => {
    expectTypeOf<StockStatus>().toEqualTypeOf<Enums["stock_status"]>();
  });
});
