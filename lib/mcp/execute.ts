import "server-only";

import { execute, parse, type DocumentNode } from "graphql";
import { schema } from "../graphql/schema";
import { runWithIdentity } from "../auth/request-context";
import type { GraphQLContext } from "../graphql/context";

/**
 * Runs one MCP tool by executing its GraphQL document IN-PROCESS against the very
 * schema `/api/graphql` serves.
 *
 * This is the whole security story of the MCP server, and it is a story about
 * NOT writing one. A tool is a GraphQL document plus a zod schema; running it
 * goes through `execute()` with a real {@link GraphQLContext} inside
 * `runWithIdentity`, so every gate the dashboard and the bearer API already pass
 * through applies unchanged and cannot drift:
 *
 *  - the field's `authScopes` (the introspectable contract);
 *  - `requireCapability` / `requireFolderCapabilityForApp` inside `lib/data/*`
 *    (the real boundary — see AGENTS.md);
 *  - the token's own capability clamp and project scope (`clampToToken`,
 *    `narrowedScope`), so a token scoped to one project reads another as absent;
 *  - the team's 2FA policy.
 *
 * There is no second authorization path here, and there must never be one. If a
 * tool needs a check the data layer does not already make, the check belongs in
 * the data layer, where the dashboard gets it too.
 *
 * No HTTP round trip: yoga's own plugins (depth/alias/cost limits, the JSON-POST
 * guard) are transport hardening for documents a client authored. Our documents
 * are ours — they are in this repo, they are pinned by a test, and a client can
 * only choose WHICH one runs, never what it says.
 */

/** Documents are parsed once at first use, not per call. */
const parsed = new Map<string, DocumentNode>();

function documentFor(query: string): DocumentNode {
  let doc = parsed.get(query);
  if (!doc) {
    doc = parse(query);
    parsed.set(query, doc);
  }
  return doc;
}

export interface ToolExecution {
  data: unknown;
  /** The first GraphQL error's message, surfaced verbatim — never rewritten. */
  error?: string;
}

/**
 * Execute `query` with `variables` as the principal in `ctx`.
 *
 * Errors come back as a value rather than a throw: a tool that refuses must tell
 * the model WHY in a sentence it can act on ("requires the delete_apps
 * capability"), and deplo's messages are already written to be shown to a user
 * (`maskError` guarantees no stack trace escapes). A thrown error would become
 * an opaque protocol failure instead.
 */
export async function runGraphql(
  query: string,
  variables: Record<string, unknown>,
  ctx: GraphQLContext,
): Promise<ToolExecution> {
  const run = () =>
    execute({
      schema,
      document: documentFor(query),
      variableValues: variables,
      contextValue: ctx,
    });
  // The route only ever builds a token principal, so `identity` is always set;
  // the guard is here because a null one must mean "resolve nothing" rather than
  // "run unattributed" — `runWithIdentity` has no null form, and the data layer's
  // own gates refuse an anonymous caller anyway.
  const value = await (ctx.identity ? runWithIdentity(ctx.identity, run) : run());
  const error = value.errors?.[0]?.message;
  return { data: value.data ?? null, error };
}
