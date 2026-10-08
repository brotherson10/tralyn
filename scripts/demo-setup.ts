/**
 * LOCAL demo environment for visual review, screenshots and portfolio.
 *
 *   npm run demo:setup
 *
 * DESTRUCTIVE FOR THE LOCAL DATABASE ONLY: resets the local Supabase stack
 * (project_id "tralyn") and rebuilds the demo from scratch, so every run
 * ends in the same state (DEMO_VISUAL_STATE). It refuses to run unless every
 * signal points at the loopback stack; there is no hosted mode and no option
 * to bypass the guard (the command takes no arguments).
 *
 * Exit: 0 ready · 1 setup failed · 2 refused (arguments or target).
 */
import { DEMO_PASSWORD, DEMO_USERS } from "./demo/data";
import { demoArgsProblems } from "./demo/guard";
import { DemoSetupError, runDemoSetup } from "./demo/setup";

async function main(): Promise<number> {
  const argProblems = demoArgsProblems(process.argv.slice(2));
  if (argProblems.length > 0) {
    console.error(`RECUSADO — ${argProblems.join("; ")}. Uso: npm run demo:setup (sem argumentos).`);
    return 2;
  }
  const report = await runDemoSetup();
  console.log(
    JSON.stringify(
      {
        target: "local",
        canonicalImport: report.canonicalImport,
        demo: {
          counts: report.state.counts,
          totalStock: report.state.totalStock,
          statusCounts: report.state.statusCounts,
          projectsByStatus: report.state.projectsByStatus,
        },
        // Local-only demo accounts (fictional, deliberately non-sensitive password).
        logins: DEMO_USERS.map((u) => ({ role: u.role, email: u.email })),
        password: DEMO_PASSWORD,
        app: "npm run dev → http://localhost:3000/login",
      },
      null,
      2,
    ),
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "erro desconhecido";
    const refused = error instanceof DemoSetupError && message.startsWith("Alvo recusado");
    // Message only (never the error object, stack, keys or connection strings).
    console.error(`${refused ? "RECUSADO" : "FALHOU"} — ${message}`);
    process.exitCode = refused ? 2 : 1;
  });
