import { connection } from "next/server";
import { headers } from "next/headers";

import { clientAddress } from "@/lib/http/client-address";

// The caller's own address, so a server agent learns where its traffic leaves from (ADR-0050). Reads nothing else.
export async function GET() {
  await connection();
  const address = clientAddress(await headers()) ?? "";
  return new Response(address, {
    status: address ? 200 : 404,
    headers: { "cache-control": "no-store", "content-type": "text/plain" },
  });
}
