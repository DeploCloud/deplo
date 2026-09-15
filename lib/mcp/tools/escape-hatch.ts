import * as z from "zod";
import type { GraphQLContext } from "../../graphql/context";
import { tool, type McpToolDef } from "./tool-def";

const PASSTHROUGH_VARIABLES = z
  .record(z.string(), z.unknown())
  .optional()
  .describe("Values for the document's variables.");

async function passthrough(
  args: { query: string; variables?: Record<string, unknown> },
  ctx: GraphQLContext,
  kind: "query" | "mutation",
) {
  const { admitPassthrough, runGraphql } = await import("../execute");
  const { data, error } = await runGraphql(
    admitPassthrough(args.query, kind),
    args.variables ?? {},
    ctx,
  );
  if (error) throw new Error(error);
  return data;
}

export const ESCAPE_HATCH: McpToolDef[] = [
  tool({
    name: "graphql_query",
    title: "Run a GraphQL read",
    description:
      'Last resort: read anything the curated tools do not cover, straight from Deplo\'s GraphQL API. Discover fields with __type(name: "Query"). Ask for few fields at a time.',
    group: "Escape hatch",
    requires: null,
    readOnly: true,
    idempotent: true,
    input: z.object({
      query: z
        .string()
        .describe("A GraphQL query document. Mutations are refused here."),
      variables: PASSTHROUGH_VARIABLES,
    }),
    query: "",
    run: (a, ctx) => passthrough(a, ctx, "query"),
  }),
  tool({
    name: "graphql_mutate",
    title: "Run a GraphQL write",
    description:
      'Last resort: a write no curated tool covers, straight from Deplo\'s GraphQL API. Prefer a named tool where one exists. Discover fields with graphql_query and __type(name: "Mutation").',
    group: "Escape hatch",
    requires: null,
    destructive: true,
    input: z.object({
      query: z
        .string()
        .describe("A GraphQL mutation document. Queries are refused here."),
      variables: PASSTHROUGH_VARIABLES,
    }),
    query: "",
    run: (a, ctx) => passthrough(a, ctx, "mutation"),
  }),
];
