import { buildContext } from "@/lib/graphql/context";
import { runPlayground } from "@/lib/graphql/playground";

/**
 * The in-dashboard GraphQL playground endpoint — a SAFE sandbox in front of the
 * real `/api/graphql` schema (see `lib/graphql/playground.ts` for the model):
 * read-only queries execute for real against the caller's session data, while
 * mutations are never run — they are simulated as a capability-aware dry run.
 *
 * Auth is the dashboard session cookie (`buildContext` resolves the viewer the
 * same way the real endpoint does). A bearer token works too, but the playground
 * UI only ever calls this same-origin with the cookie.
 *
 * Node runtime: the schema/data layer use Node APIs and `cookies()`, and this
 * reads per-request identity, so it can never be prerendered.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { kind: "error", errors: [{ message: "Invalid JSON body." }] },
      { status: 400 },
    );
  }

  const query = typeof body.query === "string" ? body.query : null;
  if (!query) {
    return Response.json(
      { kind: "error", errors: [{ message: "Missing `query`." }] },
      { status: 400 },
    );
  }

  const variables =
    body.variables && typeof body.variables === "object"
      ? (body.variables as Record<string, unknown>)
      : undefined;
  const operationName =
    typeof body.operationName === "string" ? body.operationName : null;

  const ctx = await buildContext(request);
  const result = await runPlayground(query, variables, operationName, ctx);
  return Response.json(result);
}
