import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { nowIso } from "../../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { securityState } from "../../security-updates/state";
import { recordActivity } from "../activity";

export interface SecurityUpdatesStatus {
  enabled: boolean;
  lastCheckedAt: string | null;
  failingSince: string | null;
}

export async function securityUpdatesStatus(): Promise<SecurityUpdatesStatus> {
  await requireInstanceAdmin();
  const s = await securityState();
  return {
    enabled: s.enabled,
    lastCheckedAt: s.checkedAt,
    failingSince: s.failingSince,
  };
}

// https://deplo.build/docs/guides/observability/security-updates#what-deplo-sends
export async function setSecurityUpdatesEnabled(
  enabled: boolean,
): Promise<SecurityUpdatesStatus> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: "default", securityUpdatesEnabled: enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { securityUpdatesEnabled: enabled, updatedAt: now },
    });
  await recordActivity(
    "instance",
    enabled ? "Turned on security updates" : "Turned off security updates",
    user.name,
    null,
    teamId,
  );
  return securityUpdatesStatus();
}
