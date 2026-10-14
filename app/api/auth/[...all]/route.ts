import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/better-auth";
import { rateLimit } from "@/lib/security";
import { capRequestBody } from "@/lib/http/body-cap";
import { clientAddress, clientAddressKey } from "@/lib/http/client-address";

function notConfigured() {
  return new Response("Auth provider not configured", { status: 501 });
}

const REGISTER_LIMIT = { limit: 5, windowMs: 60_000 };

const REGISTER_CEILING = { limit: 60, windowMs: 60_000 };

async function registrationAllowed(request: Request): Promise<Response | null> {
  if (!new URL(request.url).pathname.endsWith("/oauth2/register")) return null;
  const [perIp, overall] = await Promise.all([
    rateLimit(
      `oauth-register:${clientAddressKey(request.headers)}`,
      REGISTER_LIMIT,
    ),
    rateLimit("oauth-register:all", REGISTER_CEILING),
  ]);
  const limited = perIp.ok ? overall : perIp;
  if (limited.ok) return null;
  return Response.json(
    {
      error: "slow_down",
      error_description: "Too many client registrations. Try again shortly.",
    },
    { status: 429, headers: { "retry-after": String(limited.retryAfterSec) } },
  );
}

// Better Auth reads only x-real-ip, so its limiter and session rows see the address ours do.
function withClientAddress(request: Request): Request {
  const headers = new Headers(request.headers);
  const ip = clientAddress(request.headers);
  if (ip) headers.set("x-real-ip", ip);
  else headers.delete("x-real-ip");
  return new Request(request, { headers });
}

export async function GET(request: Request) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return toNextJsHandler(auth).GET(withClientAddress(request));
}

export async function POST(request: Request) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  const capped = await capRequestBody(request);
  if (capped instanceof Response) return capped;
  const refused = await registrationAllowed(capped);
  if (refused) return refused;
  return toNextJsHandler(auth).POST(withClientAddress(capped));
}
