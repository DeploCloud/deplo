import { connection } from "next/server";

export async function GET() {
  await connection();
  return Response.json(
    { ok: true },
    {
      headers: {
        // Without no-store an intermediary can serve a cached 200 while the origin is down.
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    },
  );
}
