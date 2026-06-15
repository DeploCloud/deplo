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

const nextConfig: NextConfig = {
  // Self-contained server bundle for Docker deploys (copies a minimal runtime).
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  // Keep native/server-only DB + auth packages out of the bundler so their
  // dynamic requires resolve correctly at runtime.
  serverExternalPackages: ["pg", "better-auth"],
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
