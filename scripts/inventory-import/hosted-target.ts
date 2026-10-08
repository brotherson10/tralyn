/**
 * Target guard for the HOSTED inventory dry-run. Separate from target.ts (the
 * local CLI keeps refusing every remote host). Accepts only the PostgreSQL of
 * the single authorized project, through:
 *
 *   direct:          postgres@db.<ref>.supabase.co:5432/postgres
 *   session pooler:  postgres.<ref>@aws-N-<region>.pooler.supabase.com:5432/postgres
 *
 * Transaction pooling (6543) is refused. TLS is verify-full against the CA
 * certificate the operator downloads from the dashboard. The connection
 * string and CA path come only from the environment; nothing is echoed.
 */
import { readFileSync } from "node:fs";

export const HOSTED_DATABASE_URL_ENV = "INVENTORY_HOSTED_DATABASE_URL";
export const HOSTED_DATABASE_CA_ENV = "INVENTORY_HOSTED_DATABASE_CA_FILE";

const POOLER_HOST = /^aws-\d+-[a-z]{2}-[a-z]+-\d+\.pooler\.supabase\.com$/;

export class HostedImportTargetError extends Error {
  constructor(reason: string) {
    super(`Alvo hospedado recusado: ${reason}.`);
    this.name = "HostedImportTargetError";
  }
}

export interface HostedDatabaseTarget {
  kind: "direct" | "session-pooler";
  host: string;
  port: number;
  user: string;
  database: string;
  /** Never printed; only handed to the pg client. */
  password: string;
}

export function assertHostedDatabaseUrl(connectionString: string | undefined, ref: string): HostedDatabaseTarget {
  if (!connectionString) throw new HostedImportTargetError(`variável ${HOSTED_DATABASE_URL_ENV} não definida`);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new HostedImportTargetError("connection string inválida");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new HostedImportTargetError("protocolo não PostgreSQL");
  if (url.search || url.hash) throw new HostedImportTargetError("parâmetros na connection string não são permitidos");

  const host = url.hostname.toLowerCase();
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const port = Number(url.port || "5432");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  let kind: HostedDatabaseTarget["kind"];
  if (host === `db.${ref}.supabase.co`) {
    if (user !== "postgres") throw new HostedImportTargetError("utilizador inesperado para a ligação direta");
    kind = "direct";
  } else if (POOLER_HOST.test(host)) {
    if (user !== `postgres.${ref}`) throw new HostedImportTargetError("o utilizador do pooler não pertence ao projeto autorizado");
    kind = "session-pooler";
  } else {
    throw new HostedImportTargetError("host não pertence ao projeto autorizado");
  }
  if (port !== 5432) throw new HostedImportTargetError("só a porta 5432 é aceite (sem transaction pooling)");
  if (database !== "postgres") throw new HostedImportTargetError("base de dados inesperada");
  if (!password) throw new HostedImportTargetError("password em falta na connection string");
  return { kind, host, port, user, database, password };
}

/** PEM CA certificate for verify-full TLS (public data, but required). */
export function readHostedCa(path: string | undefined): string {
  if (!path) throw new HostedImportTargetError(`variável ${HOSTED_DATABASE_CA_ENV} não definida (certificado CA do projeto)`);
  let pem: string;
  try {
    pem = readFileSync(path, "utf8");
  } catch {
    throw new HostedImportTargetError("certificado CA ilegível");
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) throw new HostedImportTargetError("certificado CA inválido (PEM esperado)");
  return pem;
}
