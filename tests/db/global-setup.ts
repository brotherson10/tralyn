import pg from "pg";
import { localStack } from "./helpers";

/**
 * The integration tests share the local stack with the demo environment. The
 * canonical import tests need products without foreign movements, so a DB
 * holding the demo (`npm run demo:setup`) is refused up front with a clear
 * instruction instead of failing deep inside a test.
 */
export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: localStack().dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ demo: boolean }>(`select exists (select 1 from auth.users where email like '%@tralyn.test') as demo`);
    if (rows[0].demo) {
      throw new Error("A base de dados local contém a demo (npm run demo:setup). Execute `npm run db:reset` antes de `npm run test:db`.");
    }
  } finally {
    await client.end();
  }
}
