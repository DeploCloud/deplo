import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { SETTINGS_ID } from "./instance-settings/settings-store";

/** Whether this instance is offered canary (pre-release) versions of Deplo. Agents follow the panel's pin, never the channel. */
export async function canaryReleasesEnabled(): Promise<boolean> {
  const rows = await getDb()
    .select({ canary: instanceSettings.canaryReleases })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID))
    .limit(1);
  return rows[0]?.canary ?? false;
}
