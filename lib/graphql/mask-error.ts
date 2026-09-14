import "server-only";

import { GraphQLError } from "graphql";

import { unreachableMessage } from "../infra/server-health";

// Never leaked: Drizzle embeds SQL + bound params, pg a SQLSTATE, gRPC a dial address.
function isInternalError(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  if (e.name === "DrizzleQueryError" || e.message.startsWith("Failed query:"))
    return true;
  // A plain `new Error("You don't have permission")` carries no `.code`, so it is kept.
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number";
}

// userFacingMessage keeps an intentional user-facing message verbatim, masks internals.
export function userFacingMessage(error: unknown): string | null {
  if (error instanceof GraphQLError) {
    const orig = error.originalError;
    if (!orig || orig instanceof GraphQLError) return error.message;
    error = orig;
  }
  const unreachable = unreachableMessage(error);
  if (unreachable) return unreachable;
  if (error instanceof Error && !isInternalError(error)) return error.message;
  return null;
}

// safeMessage is the client-safe message for `error`, logged server-side when masked.
export function safeMessage(error: unknown): string {
  const msg = userFacingMessage(error);
  if (msg != null) return msg;
  console.error("[graphql] masked internal error:", error);
  return "Something went wrong";
}

// maskError is Yoga's `maskedErrors.maskError` hook.
export function maskError(error: unknown): GraphQLError {
  return new GraphQLError(safeMessage(error));
}
