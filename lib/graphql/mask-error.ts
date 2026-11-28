import "server-only";

import { GraphQLError } from "graphql";

import { unreachableMessage } from "../infra/server-health";
import { TeamUnavailableError } from "../team-path";

// A `.code` means Drizzle, pg or gRPC built it: those carry SQL, bound params or a dial address.
function isInternalError(e: unknown): boolean {
  if (!(e instanceof Error)) return true;
  if (e.name === "DrizzleQueryError" || e.message.startsWith("Failed query:"))
    return true;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number";
}

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

export function safeMessage(error: unknown): string {
  const msg = userFacingMessage(error);
  if (msg != null) return msg;
  console.error("[graphql] masked internal error:", error);
  return "Something went wrong";
}

export function maskError(error: unknown): GraphQLError {
  // One raised on purpose keeps its extensions (a 403's status); its message was always shown as it is.
  if (error instanceof GraphQLError && !error.originalError) return error;
  const cause = error instanceof GraphQLError ? error.originalError : error;
  if (cause instanceof TeamUnavailableError)
    return new GraphQLError(cause.message, {
      extensions: { code: "FORBIDDEN", http: { status: 403 } },
    });
  return new GraphQLError(safeMessage(error));
}
