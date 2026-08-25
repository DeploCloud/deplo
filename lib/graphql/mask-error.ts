import "server-only";

import { GraphQLError } from "graphql";

/**
 * What may be said to a client when a resolver throws.
 */

/**
 * An INFRASTRUCTURE error whose message must never reach a client: a Drizzle
 * wrapper (its message embeds the raw SQL + bound params — which can include
 * secret values), a Postgres error (SQLSTATE `.code` + table/column identifiers),
 */
function isInternalError(e: unknown): boolean {
  if (!(e instanceof Error)) return true; // a non-Error throw is never user copy
  if (e.name === "DrizzleQueryError" || e.message.startsWith("Failed query:"))
    return true;
  // pg carries a string SQLSTATE; gRPC/Node carry a string or numeric code. A
  // plain `new Error("You don't have permission")` has no `code`, so it is kept.
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number";
}

/**
 * Never leak internals, but PRESERVE the repo's "surface the server's message
 * verbatim" contract for the intentional, user-facing errors resolvers and the
 * data layer throw ("You don't have permission to deploy", "Too many attempts",
 */
export function userFacingMessage(error: unknown): string | null {
  if (error instanceof GraphQLError) {
    const orig = error.originalError;
    // A GraphQLError our code threw directly (no non-GraphQL cause) is user copy.
    if (!orig || orig instanceof GraphQLError) return error.message;
    error = orig; // otherwise inspect the wrapped cause below
  }
  if (error instanceof Error && !isInternalError(error)) return error.message;
  return null;
}

/** The safe message for `error`, logging it server-side when it is masked. */
export function safeMessage(error: unknown): string {
  const msg = userFacingMessage(error);
  if (msg != null) return msg;
  console.error("[graphql] masked internal error:", error);
  return "Something went wrong";
}

/** Yoga's `maskedErrors.maskError` hook. */
export function maskError(error: unknown): GraphQLError {
  return new GraphQLError(safeMessage(error));
}
