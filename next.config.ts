import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // E2E tests build into a separate folder (NEXT_DIST_DIR=.next-e2e) so they
  // never overwrite the regular build, which points at the hosted project.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
