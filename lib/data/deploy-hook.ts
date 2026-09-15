import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { getCurrentUser } from "../auth/current-user";
import { nowIso } from "../ids";
import {
  constantTimeEquals,
  decryptSecret,
  encryptSecret,
  randomToken,
} from "../crypto";
import { instancePublicBaseUrl } from "./instance-settings/settings-store";
import { recordActivity } from "./activity";
import { appInTeam } from "./app-graph-load";
import { requireAppCapability } from "./node-access";

async function hookPrefix(appId: string): Promise<string> {
  return `${await baseUrl()}/api/apps/${appId}/deploy-hook/`;
}

async function baseUrl(): Promise<string> {
  return instancePublicBaseUrl();
}

export async function deployHookUrlMasked(appId: string): Promise<string> {
  return `${await hookPrefix(appId)}••••••••••••`;
}

export async function revealDeployHook(appId: string): Promise<string> {
  const { membership } = await requireAppCapability(appId, "configure_apps");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");

  const [row] = await getDb()
    .select({ tokenEnc: appsTable.deployHookTokenEnc })
    .from(appsTable)
    .where(
      and(eq(appsTable.id, appId), eq(appsTable.teamId, membership.teamId)),
    )
    .limit(1);
  if (!row) throw new Error("App not found");

  const existing = row.tokenEnc ? decryptSecret(row.tokenEnc) : "";
  if (existing) return `${await hookPrefix(appId)}${existing}`;
  return mint(appId, membership.teamId);
}

export async function rotateDeployHook(appId: string): Promise<string> {
  const { membership } = await requireAppCapability(appId, "configure_apps");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  const user = (await getCurrentUser())!;
  const url = await mint(appId, membership.teamId);
  await recordActivity("app", "Rotated the deploy hook URL", user.name, appId);
  return url;
}

async function mint(appId: string, teamId: string): Promise<string> {
  const token = randomToken(24);
  const updated = await getDb()
    .update(appsTable)
    .set({ deployHookTokenEnc: encryptSecret(token), updatedAt: nowIso() })
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  return `${await hookPrefix(appId)}${token}`;
}

export async function setDeployHookEnabled(
  appId: string,
  value: boolean,
): Promise<void> {
  const { membership } = await requireAppCapability(appId, "configure_apps");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  const user = (await getCurrentUser())!;
  const updated = await getDb()
    .update(appsTable)
    .set({ deployHookEnabled: value, updatedAt: nowIso() })
    .where(
      and(eq(appsTable.id, appId), eq(appsTable.teamId, membership.teamId)),
    )
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    value ? "Enabled the deploy hook" : "Disabled the deploy hook",
    user.name,
    appId,
  );
}

export type DeployHookRejection = "not-found" | "disabled" | "bad-token";

// Runs before any identity exists, so it is un-gated by design; the route re-enters the gates via runWithIdentity.
export async function verifyDeployHookToken(
  appId: string,
  token: string,
): Promise<
  { ok: true; teamId: string } | { ok: false; reason: DeployHookRejection }
> {
  const [row] = await getDb()
    .select({
      teamId: appsTable.teamId,
      tokenEnc: appsTable.deployHookTokenEnc,
      enabled: appsTable.deployHookEnabled,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (!row) return { ok: false, reason: "not-found" };
  if (!row.enabled) return { ok: false, reason: "disabled" };
  const expected = row.tokenEnc ? decryptSecret(row.tokenEnc) : "";
  if (!expected || !constantTimeEquals(token, expected))
    return { ok: false, reason: "bad-token" };
  return { ok: true, teamId: row.teamId };
}

// Un-gated like verifyDeployHookToken above: both run before the hook call has an identity.
export async function owningTeamId(appId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ teamId: appsTable.teamId })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0]?.teamId ?? null;
}
