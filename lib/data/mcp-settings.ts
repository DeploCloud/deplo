import "server-only";

import { cache } from "@/lib/request-cache";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { assertUser } from "../auth/current-user";
import { recordActivity } from "./activity";

export interface McpSettings {
  enabled: boolean;
}

export const getMcpSettings = cache(async (): Promise<McpSettings> => {
  const teamId = await requireActiveTeamId();
  const row = (
    await getDb()
      .select({ enabled: teamsTable.mcpEnabled })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];
  return { enabled: row?.enabled ?? false };
});

export async function setMcpSettings(input: {
  enabled: boolean;
}): Promise<McpSettings> {
  const { teamId } = await requireCapability("manage_team");
  await requireTeamWide("the team's MCP settings");

  const before = (
    await getDb()
      .select({ enabled: teamsTable.mcpEnabled })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];
  if (!before) throw new Error("No team");

  await getDb()
    .update(teamsTable)
    .set({ mcpEnabled: input.enabled })
    .where(eq(teamsTable.id, teamId));

  if (input.enabled !== before.enabled)
    await recordActivity(
      "mcp",
      `AI agents can ${input.enabled ? "now" : "no longer"} drive this team over MCP`,
      (await assertUser()).name,
      null,
      teamId,
    );
  return { enabled: input.enabled };
}
