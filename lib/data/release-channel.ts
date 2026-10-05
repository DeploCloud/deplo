import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import {
  resolveExpectedAgentVersion,
  type AgentChannel,
} from "../agent/release";
import { SETTINGS_ID } from "./instance-settings/settings-store";

/** Whether this instance is offered canary (pre-release) versions: of Deplo and of every server's agent. */
export async function canaryReleasesEnabled(): Promise<boolean> {
  const rows = await getDb()
    .select({ canary: instanceSettings.canaryReleases })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  return rows[0]?.canary ?? false;
}

// One channel for the whole fleet: an agent ahead of or behind its panel's channel is not supported.
export async function releaseChannel(): Promise<AgentChannel> {
  return (await canaryReleasesEnabled()) ? "canary" : "stable";
}

/** The agent version every server should run, on the instance's channel. */
export async function expectedAgentVersion(): Promise<string> {
  return resolveExpectedAgentVersion(await releaseChannel());
}
