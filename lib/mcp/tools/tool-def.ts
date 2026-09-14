import * as z from "zod";
import type { Capability } from "../../types/identity";
import type { GraphQLContext } from "../../graphql/context";

export type ToolRequirement = Capability | "instanceAdmin";

// McpToolDef - one row of the MCP tool table.
export interface McpToolDef<
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  // Unprefixed: clients already namespace by server ("deplo").
  name: string;
  title: string;
  // One line the model reads to decide whether this is the right tool.
  description: string;
  group: string;
  input: S;
  // The GraphQL document run on the caller's behalf.
  query: string;
  // `null` = any authenticated token. Filtering is cosmetic; the data layer is the boundary.
  requires: ToolRequirement | null;
  readOnly?: boolean;
  // Its whole effect is `destructiveHint` in `tools/list`, which is what makes a client ask.
  destructive?: boolean;
  idempotent?: boolean;
  // Map tool args to GraphQL variables when the shapes differ.
  variables?: (args: z.infer<S>) => Record<string, unknown>;
  // Slice the single top-level array by `limit`/`offset`; the input schema must carry both.
  paginate?: boolean;
  // Runs instead of `query`, for the log reads and the two passthrough tools.
  run?: (args: z.infer<S>, ctx: GraphQLContext) => Promise<unknown>;
}

// tool - types each row's callbacks by ITS OWN zod schema, not a shared record.
export const tool = <S extends z.ZodObject<z.ZodRawShape>>(
  t: McpToolDef<S>,
): McpToolDef => t as unknown as McpToolDef;

export const page = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("How many to return (default 50)."),
  offset: z.number().int().min(0).optional().describe("How many to skip."),
};

export const appId = z
  .string()
  .describe("The app's id, as returned by list_apps.");
export const databaseId = z
  .string()
  .describe("The database's id, as returned by list_databases.");
export const CRON_KIND = z
  .enum(["app", "database"])
  .optional()
  .describe("What the id names. Defaults to app.");

export const serverId = z
  .string()
  .describe("The server's id, as returned by list_servers.");
