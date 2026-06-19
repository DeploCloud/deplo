import { yoga } from "@/lib/graphql/yoga";

/**
 * The single GraphQL endpoint. Yoga handles GET (GraphiQL + queries) and POST
 * (operations). The data layer uses Node APIs (fs, crypto, the in-memory store)
 * and cookies(), so this must run on the Node.js runtime, not the edge.
 */
export const runtime = "nodejs";
// The schema reads cookies / the bearer header per request — never prerender.
export const dynamic = "force-dynamic";

function handler(request: Request): Response | Promise<Response> {
  return yoga.handleRequest(request, {});
}

export { handler as GET, handler as POST, handler as OPTIONS };
