import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url));

/** @type {import("next").NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits a self-contained server with only the files it actually imports, so
  // the runtime image does not ship node_modules for the whole monorepo.
  output: "standalone",
  // The workspace root, not apps/web: tracing from the package directory misses
  // the hoisted node_modules and the shared package, and the standalone build
  // then starts and immediately fails on a missing module.
  outputFileTracingRoot: workspaceRoot,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
  },
  poweredByHeader: false,
  // Baseline hardening on every page. Framing is refused outright: the review
  // screens carry decision buttons, and a page that can be framed can be
  // clickjacked into pressing them.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
