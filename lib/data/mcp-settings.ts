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

// McpSettings is the active team's MCP policy - the one switch on Settings → MCP Server.
export interface McpSettings {
  enabled: boolean;
}

// getMcpSettings reads the active team's MCP policy.
export const getMcpSettings = cache(async (): Promise<McpSettings> => {
  const teamId = await requireActiveTeamId();
  const row = (
    await getDb()
      .select({ enabled: teamsTable.mcpEnabled })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];
  // Fail closed: "off" is the right way to be wrong about a kill switch.
  return { enabled: row?.enabled ?? false };
});

// setMcpSettings turns MCP access on or off for the active team.
export async function setMcpSettings(input: {
  enabled: boolean;
}): Promise<McpSettings> {
  // manage_team, not manage_mcp: this is a team policy, not a member's own connection.
  const { teamId } = await requireCapability("manage_team");
  // A narrowed token reaches part of the team; this switch governs all of it.
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
