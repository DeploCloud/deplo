import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { teams as teamsTable } from "../db/schema/control-plane";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { assertUser } from "../auth";
import { recordActivity } from "./activity";

/**
 * The active team's MCP policy — the two switches on Settings → MCP Server.
 *
 * Deliberately NOT part of the `Team` DTO: `getTeam()` is read on every dashboard
 * page, and neither field belongs in that hot path. Both are read in exactly two
 * places — the settings page, and `/api/mcp` before it dispatches a single tool.
 */
export interface McpSettings {
  /** Whether this team's API tokens may drive it over `/api/mcp`. */
  enabled: boolean;
  /**
   * Whether a destructive tool must come back through the human first (MRTR
   * `input_required`, protocol revision 2026-07-28).
   */
  confirmDestructive: boolean;
}

/**
 * Read the active team's MCP policy.
 *
 * NOT gated on `manage_mcp`: `/api/mcp` itself has to read this on every request,
 * as whatever principal the token carries, and a token that may deploy an app has
 * no business also holding the capability that governs the switch. The capability
 * guards CHANGING the policy ({@link setMcpSettings}) and the settings page that
 * shows it, not the endpoint's own read of its own kill switch.
 */
export const getMcpSettings = cache(async (): Promise<McpSettings> => {
  const teamId = await requireActiveTeamId();
  const row = (
    await getDb()
      .select({
        enabled: teamsTable.mcpEnabled,
        confirmDestructive: teamsTable.mcpConfirmDestructive,
      })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];
  // A missing row cannot happen behind requireActiveTeamId, but defaulting to
  // "off" rather than "on" is the right way to be wrong about a kill switch.
  return {
    enabled: row?.enabled ?? false,
    confirmDestructive: row?.confirmDestructive ?? true,
  };
});

/** Change the active team's MCP policy. Both fields are optional; absent = unchanged. */
export async function setMcpSettings(input: {
  enabled?: boolean;
  confirmDestructive?: boolean;
}): Promise<McpSettings> {
  const { teamId } = await requireCapability("manage_mcp");
  // A narrowed token (one scoped to a project, folder or app) reaches part of the
  // team, and this switch governs all of it.
  await requireTeamWide("the team's MCP settings");

  const before = (
    await getDb()
      .select({
        enabled: teamsTable.mcpEnabled,
        confirmDestructive: teamsTable.mcpConfirmDestructive,
      })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];
  if (!before) throw new Error("No team");

  const after: McpSettings = {
    enabled: input.enabled ?? before.enabled,
    confirmDestructive: input.confirmDestructive ?? before.confirmDestructive,
  };
  await getDb()
    .update(teamsTable)
    .set({
      mcpEnabled: after.enabled,
      mcpConfirmDestructive: after.confirmDestructive,
    })
    .where(eq(teamsTable.id, teamId));

  // Outside any transaction (recordActivity owns its own connection). Both
  // changes are worth a trail: one decides whether AI agents may act at all, the
  // other whether they may act unattended.
  const actor = (await assertUser()).name;
  if (after.enabled !== before.enabled)
    await recordActivity(
      "mcp",
      `AI agents can ${after.enabled ? "now" : "no longer"} drive this team over MCP`,
      actor,
      null,
      teamId,
    );
  if (after.confirmDestructive !== before.confirmDestructive)
    await recordActivity(
      "mcp",
      `AI agents ${
        after.confirmDestructive ? "must now ask" : "no longer ask"
      } before destructive actions over MCP`,
      actor,
      null,
      teamId,
    );
  return after;
}
