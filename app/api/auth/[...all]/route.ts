import { toNextJsHandler } from "better-auth/next-js";
import { getAuth } from "@/lib/auth/better-auth";

/**
 * Better Auth endpoints (`/api/auth/*`). Active only when Postgres is
 * configured; otherwise the app uses the built-in session auth and this returns
 * 501 so callers fail clearly instead of silently.
 */

function notConfigured() {
  return new Response("Auth provider not configured", { status: 501 });
}

export async function GET(request: Request) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return toNextJsHandler(auth).GET(request);
}

export async function POST(request: Request) {
  const auth = getAuth();
  if (!auth) return notConfigured();
  return toNextJsHandler(auth).POST(request);
}
