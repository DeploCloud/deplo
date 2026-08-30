// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

import { execute, parse, type DocumentNode } from "graphql";
import { schema } from "../graphql/schema";
import { runWithIdentity } from "../auth/request-context";
import type { GraphQLContext } from "../graphql/context";

/**
 * Runs one MCP tool by executing its GraphQL document IN-PROCESS against the very
 * schema `/api/graphql` serves. There is no second authorization path here, and
 * there must never be one.
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
  /** The first GraphQL error's message, surfaced verbatim, never rewritten. */
  error?: string;
}

/**
 * Execute `query` with `variables` as the principal in `ctx`. A thrown error would
 * become an opaque protocol failure instead.
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
  // The route only ever builds a token principal, so `identity` is always set; the
  // guard is here because a null one must mean "resolve nothing" rather than "run
  // unattributed" - `runWithIdentity` has no null form, and the data layer's own
  const value = await (ctx.identity
    ? runWithIdentity(ctx.identity, run)
    : run());
  const error = value.errors?.[0]?.message;
  return { data: value.data ?? null, error };
}
