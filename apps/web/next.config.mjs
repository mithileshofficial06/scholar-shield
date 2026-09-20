/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server with only the files it actually imports, so
  // the runtime image does not ship node_modules for the whole monorepo.
  output: "standalone",
  // The workspace root, not apps/web: tracing from the package directory misses
  // the hoisted node_modules and the shared package, and the standalone build
  // then starts and immediately fails on a missing module.
  outputFileTracingRoot: new URL("../../", import.meta.url).pathname,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  },
};

export default nextConfig;
