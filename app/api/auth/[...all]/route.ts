import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/better-auth";
import { rateLimit } from "@/lib/security";

/**
 * Better Auth endpoints (`/api/auth/*`). Active only when Postgres is
 * configured; otherwise the app uses the built-in session auth and this returns
 * 501 so callers fail clearly instead of silently.
 */

function notConfigured() {
  return new Response("Auth provider not configured", { status: 501 });
}

/**
 * `/oauth2/register` is the only UNAUTHENTICATED write endpoint deplo exposes,
 * and it has to be open: claude.ai and ChatGPT cannot pre-register (RFC 7591).
 *
 * The plugin ships its own per-endpoint limiter, but it is Better Auth's
 * in-memory one — it forgets on every restart and counts separately per
 * instance, the two failure modes `lib/security.ts` exists to avoid (its suite
 * has a test named "the count SURVIVES a restart"). So the Postgres limiter runs
 * in front of it. Keyed on IP because there is no principal yet.
 */
const REGISTER_LIMIT = { limit: 5, windowMs: 60_000 };

/**
 * The ceiling the per-address limit cannot provide.
 *
 * `x-forwarded-for` is a header, and on an instance that is not behind a proxy
 * stripping it, whoever is calling can write whatever they like in it and get a
 * fresh budget every request. So the per-address limit shapes ordinary traffic
 * and this one bounds the total: no plausible instance sees sixty new AI clients
 * registering in a minute, and one that does can wait.
 */
const REGISTER_CEILING = { limit: 60, windowMs: 60_000 };

async function registrationAllowed(request: Request): Promise<Response | null> {
  if (!new URL(request.url).pathname.endsWith("/oauth2/register")) return null;
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const [perIp, overall] = await Promise.all([
    rateLimit(`oauth-register:${ip}`, REGISTER_LIMIT),
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

export async function GET(request: Request) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return toNextJsHandler(auth).GET(request);
}

export async function POST(request: Request) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  const refused = await registrationAllowed(request);
  if (refused) return refused;
  return toNextJsHandler(auth).POST(request);
}
