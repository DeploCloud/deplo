import "server-only";

// https://deplo.build/docs/guides/releases/automatic-deployments

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import {
  constantTimeEquals,
  decryptSecret,
  encryptSecret,
  randomToken,
} from "../crypto";
import { instancePublicBaseUrl } from "./instance-settings";
import { recordActivity } from "./activity";
import { appInTeam } from "./app-graph-load";
import { requireAppCapability } from "./node-access";

/**
 * The per-app DEPLOY HOOK: one URL that triggers a production deployment.
 */

/** Where an app's hook lives, minus the secret segment. Public by itself. */
async function hookPrefix(appId: string): Promise<string> {
  return `${await baseUrl()}/api/apps/${appId}/deploy-hook/`;
}

/**
 * This instance's public base URL: the address an admin set in Settings → Deplo,
 * otherwise the `DEPLO_PUBLIC_URL` it was installed with, otherwise the request's
 * own host.
 */
async function baseUrl(): Promise<string> {
  return instancePublicBaseUrl();
}

/**
 * The masked hook URL for the settings page - the real link with its secret
 * segment replaced by dots, so the page can show the SHAPE of the URL (and which
 * app it points at) without the token ever reaching a browser that only asked to
 */
export async function deployHookUrlMasked(appId: string): Promise<string> {
  return `${await hookPrefix(appId)}••••••••••••`;
}

/**
 * The app's real hook URL, minting the token on first use.
 */
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

  // An existing token that no longer decrypts (DEPLO_SECRET was rotated) is
  // unusable by the endpoint too, so re-mint rather than hand back half a URL.
  const existing = row.tokenEnc ? decryptSecret(row.tokenEnc) : "";
  if (existing) return `${await hookPrefix(appId)}${existing}`;
  return mint(appId, membership.teamId);
}

/**
 * Rotate the hook: a new URL, and every copy of the old one stops working the
 * moment this returns. The way back from a link pasted somewhere it shouldn't
 * have been.
 */
export async function rotateDeployHook(appId: string): Promise<string> {
  const { membership } = await requireAppCapability(appId, "configure_apps");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  const user = (await getCurrentUser())!;
  const url = await mint(appId, membership.teamId);
  await recordActivity("app", "Rotated the deploy hook URL", user.name, appId);
  return url;
}

/** Write a fresh token and return the URL it makes. */
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

/** Turn the hook on or off. Off ⇒ the endpoint refuses before anything else. */
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

/** Why a hook call was refused - the endpoint maps these onto status codes. */
export type DeployHookRejection = "not-found" | "disabled" | "bad-token";

/**
 * Check a hook call's URL token against the stored one. The AUTHENTICATOR, not a
 * gated read - like `authenticateToken` for bearer tokens, it runs before any
 * identity exists and therefore takes no capability.
 */
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
  // No stored token ⇒ nobody has ever opened this app's hook, so no URL can be
  // valid for it. Decrypting to "" (rotated DEPLO_SECRET) lands here too, which
  // is the right answer: that link is dead until someone rotates it.
  const expected = row.tokenEnc ? decryptSecret(row.tokenEnc) : "";
  if (!expected || !constantTimeEquals(token, expected))
    return { ok: false, reason: "bad-token" };
  return { ok: true, teamId: row.teamId };
}

/**
 * The team that owns an app, by id - un-gated on purpose, and deliberately kept
 * beside the other pre-identity helper in this file.
 */
export async function owningTeamId(appId: string): Promise<string | null> {
  const rows = await getDb()
    .select({ teamId: appsTable.teamId })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  return rows[0]?.teamId ?? null;
}
