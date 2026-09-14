import { yoga } from "@/lib/graphql/yoga";
import { withRequestCache } from "@/lib/request-cache";
import { capRequestBody } from "@/lib/http/body-cap";

// The data layer uses Node APIs (fs, crypto) and cookies(), so never the edge runtime.
export const runtime = "nodejs";
// The schema reads cookies / the bearer header per request, never prerender.
export const dynamic = "force-dynamic";

async function handler(request: Request): Promise<Response> {
  // Nobody is authenticated yet when the body is read: bound it.
  const capped = await capRequestBody(request);
  if (capped instanceof Response) return capped;
  // One memo per request for the identity reads every resolver repeats; yoga.ts turns it off for mutations.
  return withRequestCache(() => yoga.handleRequest(capped, {}));
}

export { handler as GET, handler as POST, handler as OPTIONS };
