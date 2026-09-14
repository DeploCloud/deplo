import { connection } from "next/server";

// GET is the watchdog liveness probe: no auth and no DB on purpose, it answers only "is the panel reachable".
export async function GET() {
  // connection() pins this to request time; a constant-JSON GET is otherwise eligible for static optimization.
  await connection();
  return Response.json(
    { ok: true },
    {
      headers: {
        // Without no-store an intermediary can serve a cached 200 while the origin is down.
        "cache-control": "no-store",
        // Read cross-origin by the takeover screen through the old panel's proxy; it answers one bit and reads nothing.
        "access-control-allow-origin": "*",
      },
    },
  );
}
