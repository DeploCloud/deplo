import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";

export interface SecurityState {
  enabled: boolean;
  checkedAt: string | null;
  failingSince: string | null;
  kevFetchedAt: string | null;
}

export async function securityState(): Promise<SecurityState> {
  const [row] = await getDb()
    .select({
      enabled: instanceSettings.securityUpdatesEnabled,
      checkedAt: instanceSettings.securityCheckedAt,
      failingSince: instanceSettings.securityFailingSince,
      kevFetchedAt: instanceSettings.kevFetchedAt,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, "default"))
    .limit(1);
  return (
    row ?? {
      enabled: true,
      checkedAt: null,
      failingSince: null,
      kevFetchedAt: null,
    }
  );
}

export async function stampSecurityState(
  patch: Partial<Omit<SecurityState, "enabled">>,
): Promise<void> {
  await getDb()
    .update(instanceSettings)
    .set({
      ...("checkedAt" in patch ? { securityCheckedAt: patch.checkedAt } : {}),
      ...("failingSince" in patch
        ? { securityFailingSince: patch.failingSince }
        : {}),
      ...("kevFetchedAt" in patch ? { kevFetchedAt: patch.kevFetchedAt } : {}),
    })
    .where(eq(instanceSettings.id, "default"));
}
