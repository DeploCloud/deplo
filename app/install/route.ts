import type { NextRequest } from "next/server";
import { generateInstallScript } from "@/lib/install-script";
import { resolvePublicBaseUrl } from "@/lib/public-url";

/**
 * Public installer endpoint. Usage:
 *   curl -fsSL https://<host>/install | bash
 * Excluded from the proxy auth/CSP matcher so it is reachable unauthenticated.
 * The base URL is resolved safely (configured value or strictly-validated host)
 * so a spoofed Host header cannot inject content into the served script.
 */
export async function GET(request: NextRequest) {
  const baseUrl = resolvePublicBaseUrl(request.headers);
  const script = generateInstallScript({
    baseUrl,
    acmeEmail: process.env.DEPLO_ACME_EMAIL,
  });

  return new Response(script, {
    headers: {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
