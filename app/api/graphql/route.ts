import { yoga } from "@/lib/graphql/yoga";
import { withRequestCache } from "@/lib/request-cache";
import { capRequestBody } from "@/lib/http/body-cap";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handler(request: Request): Promise<Response> {
  const capped = await capRequestBody(request);
  if (capped instanceof Response) return capped;
  return withRequestCache(() => yoga.handleRequest(capped, {}));
}

export { handler as GET, handler as POST, handler as OPTIONS };
