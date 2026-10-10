/**
 * Fictitious public-demo credentials for the LOCAL e2e stack only.
 * `E2E_PUBLIC_DEMO=1 npm run test:e2e` builds the app with them and the demo
 * spec creates a matching local viewer; by default they are forced empty.
 */
export const E2E_PUBLIC_DEMO = process.env.E2E_PUBLIC_DEMO === "1";

export const E2E_DEMO_VIEWER = {
  email: "public-demo-viewer@test.local",
  password: "E2E-fictitious-demo-viewer",
} as const;
