import "server-only";

import { eq } from "drizzle-orm";
import type { ReadyCheck, RestartRule } from "../agent/gen/agent";
import { getDb } from "../db/client";
import { apps } from "../db/schema/control-plane/apps";
import { assembleHealthCheck } from "../data/app-graph-rows/health-check";
import { restartRuleFor } from "./restart-rule";

// The app's own switch and health check, read at deploy time: the rule travels with the deploy.
export async function restartRuleForApp(
  appId: string,
  ready: ReadyCheck | undefined,
): Promise<RestartRule | null> {
  if (!ready) return null;
  const [row] = await getDb().select().from(apps).where(eq(apps.id, appId));
  if (!row) return null;
  return restartRuleFor({
    enabled: row.restartWhenUnresponsive,
    // A stack's health check lives in its compose file.
    healthCheck: ready.service ? null : assembleHealthCheck(row),
    ready,
  });
}
