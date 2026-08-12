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
 * The active team's MCP policy — the one switch on Settings → MCP Server.
 *
 * There is deliberately nothing else here. What an agent may DO is the token's
 * Capabilities and nothing on top (ADR-0015, ADR-0021): a second permission
 * system beside them could only ever drift from them. This switch answers a
 * different question — whether a company allows AI agents at all — which no
 * per-token setting can express.
 *
 * Deliberately NOT part of the `Team` DTO either: `getTeam()` is read on every
 * dashboard page, and this is read in exactly two places — the settings page,
 * and `/api/mcp` before it dispatches a single tool.
 */
export interface McpSettings {
  /** Whether this team's API tokens may drive it over `/api/mcp`. */
  enabled: boolean;
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
      .select({ enabled: teamsTable.mcpEnabled })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];
  // A missing row cannot happen behind requireActiveTeamId, but defaulting to
  // "off" rather than "on" is the right way to be wrong about a kill switch.
  return { enabled: row?.enabled ?? false };
});

/** Turn MCP access on or off for the active team. */
export async function setMcpSettings(input: {
  enabled: boolean;
}): Promise<McpSettings> {
  const { teamId } = await requireCapability("manage_mcp");
  // A narrowed token (one scoped to a project, folder or app) reaches part of the
  // team, and this switch governs all of it.
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

  // Outside any transaction (recordActivity owns its own connection). Worth a
  // trail: it is the answer to "who let an AI agent into this team, and when".
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
