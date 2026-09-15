import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

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
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  allowedDevOrigins: devOrigins(),
  serverExternalPackages: ["pg", "better-auth", "nodemailer", "web-push"],
  outputFileTracingIncludes: {
    "/[team]/templates": [
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
