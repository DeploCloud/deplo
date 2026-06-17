import type { NextConfig } from "next";

/**
 * Security headers here are defense-in-depth and cover responses the proxy
 * matcher skips (API routes, static assets). The per-request CSP nonce is set
 * in proxy.ts.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

/**
 * Hostnames allowed to reach the dev server's dev-only resources.
 *
 * `next dev` binds to localhost and treats requests forwarded under any other
 * hostname (e.g. the dashboard reached via a domain through a reverse proxy) as
 * cross-origin, blocking its dev resources (/_next/webpack-hmr, the HMR runtime)
 * and so preventing the client from hydrating. We derive the hostname from
 * DEPLO_PUBLIC_URL — the same env var the app already uses for its public URL —
 * so the proxied domain works without hardcoding it. Empty (no extra origins)
 * when unset/unparseable. Has no effect on production builds.
 */
function devOrigins(): string[] {
  const raw = process.env.DEPLO_PUBLIC_URL?.trim();
  if (!raw) return [];
  try {
    return [new URL(raw.includes("://") ? raw : `https://${raw}`).hostname];
  } catch {
    return [];
  }
}

const nextConfig: NextConfig = {
  // Self-contained server bundle for Docker deploys (copies a minimal runtime).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Allow the proxied dev hostname (from DEPLO_PUBLIC_URL) to reach dev-only
  // resources; see devOrigins() above. Ignored in production builds.
  allowedDevOrigins: devOrigins(),
  // Keep native/server-only packages out of the bundler so their dynamic
  // requires resolve correctly at runtime. node-pty loads a native .node
  // (the interactive attach PTY); the Dockerfile rebuilds it for the runtime.
  serverExternalPackages: ["pg", "better-auth", "node-pty"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
