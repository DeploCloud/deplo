import "server-only";

// https://deplo.build/docs/guides/releases/automatic-deployments

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

// deployHookUrlMasked returns the hook link with its secret segment replaced by dots.
export async function deployHookUrlMasked(appId: string): Promise<string> {
  return `${await hookPrefix(appId)}••••••••••••`;
}

// revealDeployHook returns the app's real hook URL, minting the token on first use.
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

  // A token that no longer decrypts (rotated DEPLO_SECRET) is dead for the endpoint too.
  const existing = row.tokenEnc ? decryptSecret(row.tokenEnc) : "";
  if (existing) return `${await hookPrefix(appId)}${existing}`;
  return mint(appId, membership.teamId);
}

// rotateDeployHook mints a new URL; every copy of the old one stops working at once.
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

// setDeployHookEnabled turns the hook on or off; off ⇒ the endpoint refuses first.
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

// DeployHookRejection is why a hook call was refused; the endpoint maps these onto status codes.
export type DeployHookRejection = "not-found" | "disabled" | "bad-token";

// verifyDeployHookToken is the authenticator: it runs before any identity exists, so it takes no capability.
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
  // No stored token, or one that no longer decrypts, means no URL can be valid for this app.
  const expected = row.tokenEnc ? decryptSecret(row.tokenEnc) : "";
  if (!expected || !constantTimeEquals(token, expected))
    return { ok: false, reason: "bad-token" };
  return { ok: true, teamId: row.teamId };
}

// owningTeamId resolves an app's team - un-gated on purpose, beside the other pre-identity helper.
export async function owningTeamId(appId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ teamId: appsTable.teamId })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0]?.teamId ?? null;
}
