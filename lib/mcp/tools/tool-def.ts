import * as z from "zod";
import type { Capability } from "../../types/identity";
import type { GraphQLContext } from "../../graphql/context";

export type ToolRequirement = Capability | "instanceAdmin";

export interface McpToolDef<
  S extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  name: string;
  title: string;
  description: string;
  group: string;
  input: S;
  query: string;
  requires: ToolRequirement | null;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  variables?: (args: z.infer<S>) => Record<string, unknown>;
  paginate?: boolean;
  run?: (args: z.infer<S>, ctx: GraphQLContext) => Promise<unknown>;
}

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
