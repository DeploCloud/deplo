/**
 * Liveness probe for the browser's connection watchdog
 * (ServerConnectionGuard). Deliberately dependency-free — no auth, no DB —
 * because it answers exactly one question: "is the web server that hosts the
 * panel reachable?". The proxy matcher already skips /api, so this responds
 * even without a session cookie.
 */
import { connection } from "next/server";

export async function GET() {
  // A 200 must prove the server answered THIS request: connection() pins the
  // handler to request time even if Cache Components/prerendering is enabled
  // later (a constant-JSON GET is otherwise eligible for static optimization).
  await connection();
  return Response.json(
    { ok: true },
    // no-store keeps intermediaries (e.g. Cloudflare in front of the panel)
    // from serving a cached 200 while the origin is actually down.
    { headers: { "cache-control": "no-store" } },
  );
}
