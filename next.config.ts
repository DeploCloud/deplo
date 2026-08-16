import type { NextConfig } from "next";

/**
 * Security headers here are defense-in-depth and cover responses the proxy
 * matcher skips (API routes, static assets). The per-request CSP nonce is set
 * in proxy.ts.
 *
 * `Strict-Transport-Security` is deliberately NOT in this list: it must only be
 * sent when the instance is really served over TLS, and that is a RUNTIME fact
 * (the panel's address is editable in Settings), not something this file can
 * know at build time. It already lives in proxy.ts, behind the same `isHttps`
 * check that gates `upgrade-insecure-requests`. Proxy-only is enough - the
 * header is remembered per origin, and every navigation goes through the proxy.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // The panel is private — keep every response (pages, API, static assets) out
  // of every search index, even for bots that ignore robots.txt / the meta tag.
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
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
  serverExternalPackages: [
    "pg",
    "better-auth",
    "node-pty",
    // Alert delivery: both reach for node crypto/net and must not be bundled.
    "nodemailer",
    "web-push",
    // sharp is NOT listed here on purpose: Next already carries it in its own
    // built-in external list (next/dist/lib/server-external-packages.jsonc).
  ],
  // sharp (lib/templates/logo-color.ts) resolves its own `.node` from a literal
  // require the tracer can follow — but that binary then dlopens libvips from a
  // SIBLING package, and a dlopen is invisible to file tracing. The Dockerfile
  // already documents this exact failure for node-pty. Name the musl artefacts
  // explicitly or the standalone image ships a sharp that cannot load: the
  // runner is node:22-alpine, and the builder (glibc) installs both libc
  // variants, so they are present at trace time. Loading is guarded anyway —
  // a sharp that will not open costs the template tints and nothing else.
  outputFileTracingIncludes: {
    "/templates": [
      "./node_modules/@img/sharp-linuxmusl-x64/**",
      "./node_modules/@img/sharp-libvips-linuxmusl-x64/lib/*.so*",
    ],
  },
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
