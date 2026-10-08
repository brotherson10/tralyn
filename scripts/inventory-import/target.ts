/**
 * Database target guard for the importer CLI. In this stage ONLY a loopback
 * PostgreSQL is accepted, so a hosted project can never be reached by
 * accident. The connection string comes from the environment and is never
 * printed: errors describe the problem, not the value.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const DATABASE_URL_ENV = "INVENTORY_IMPORT_DATABASE_URL";

export class ImportTargetError extends Error {
  constructor(reason: string) {
    super(`Alvo de importação recusado: ${reason}.`);
    this.name = "ImportTargetError";
  }
}

export interface LocalTarget {
  host: string;
  port: number;
  database: string;
}

const isLoopbackAddress = (address: string) =>
  isIP(address) === 4 ? address.startsWith("127.") : isIP(address) === 6 ? address === "::1" : false;

/**
 * Accepts only postgres://user:pass@{127.x.x.x | [::1] | localhost}:port/db,
 * with no query parameters (libpq's ?host=/hostaddr= could redirect it).
 * "localhost" must resolve exclusively to loopback addresses.
 */
export async function assertLocalDatabaseUrl(connectionString: string | undefined): Promise<LocalTarget> {
  if (!connectionString) throw new ImportTargetError(`variável ${DATABASE_URL_ENV} não definida`);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ImportTargetError("connection string inválida");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new ImportTargetError("protocolo não PostgreSQL");
  if (url.search || url.hash) throw new ImportTargetError("parâmetros na connection string não são permitidos");

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new ImportTargetError("host em falta");
  if (host.endsWith("supabase.co") || host.endsWith("supabase.com")) throw new ImportTargetError("projeto Supabase hospedado");

  if (host === "localhost") {
    let addresses: { address: string }[];
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new ImportTargetError("localhost não resolve");
    }
    if (addresses.length === 0 || !addresses.every((a) => isLoopbackAddress(a.address))) {
      throw new ImportTargetError("localhost não resolve apenas para loopback");
    }
  } else if (!isLoopbackAddress(host)) {
    throw new ImportTargetError("host não é local (loopback)");
  }

  const port = Number(url.port || "5432");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ImportTargetError("porta inválida");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) throw new ImportTargetError("base de dados em falta");
  return { host, port, database };
}
