import "server-only";

import { headers } from "next/headers";
import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireCapability } from "../membership";
import { constantTimeEquals, decryptSecret, encryptSecret, randomToken } from "../crypto";
import { resolvePublicBaseUrl } from "../public-url";
import { recordActivity } from "./activity";
import { appInTeam } from "./app-graph-load";
import { requireFolderCapabilityForApp } from "./folder-access";

/**
 * The per-app DEPLOY HOOK: one URL that triggers a production deployment.
 *
 * deplo deploys on push already — but only from the GitHub App, the single
 * provider it receives webhooks from. A raw Git URL on GitLab, an uploaded
 * archive, a compose stack, a CI job that just pushed a new image: none of them
 * can say "deploy now" without a person opening the dashboard. This is that
 * missing verb, and it is deliberately the only one the hook has.
 *
 * TWO independent secrets have to line up, which is what makes a link safe to
 * paste into a CI config or another vendor's webhook box:
 *
 *  1. the URL's last segment — random, per app, rotatable here, stored AES-GCM
 *     encrypted (reversible on purpose: an operator must be able to read their
 *     own link back, so a one-way hash would force a rotation every time someone
 *     asked "what was that URL again?");
 *  2. an API token (`Authorization: Bearer deplo_…`, minted in Settings → API
 *     tokens) that resolves to a real member holding `deploy_apps` in the app's
 *     team — see `app/api/apps/[id]/deploy-hook/[token]/route.ts`.
 *
 * So a leaked URL alone deploys nothing, and revoking one API token kills every
 * hook call made with it, across every app, at once. `deploy_hook_enabled` is the
 * per-app kill switch on top of that.
 *
 * Everything here is gated on `configure_apps` — the same capability that owns
 * deploy-on-push and the rest of an app's deployment settings.
 */

/** Where an app's hook lives, minus the secret segment. Public by itself. */
async function hookPrefix(appId: string): Promise<string> {
  return `${await baseUrl()}/api/apps/${appId}/deploy-hook/`;
}

/**
 * This instance's public base URL. The configured `DEPLO_PUBLIC_URL` is checked
 * BEFORE `headers()` on purpose: an operator who set it has already answered the
 * question, and reading the request headers when the answer is known would tie
 * this module to a request scope for nothing. (`resolvePublicBaseUrl` prefers
 * the same value; this only avoids paying for the headers to reach it.)
 */
async function baseUrl(): Promise<string> {
  const configured = process.env.DEPLO_PUBLIC_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  return resolvePublicBaseUrl(await headers());
}

/**
 * The masked hook URL for the settings page — the real link with its secret
 * segment replaced by dots, so the page can show the SHAPE of the URL (and which
 * app it points at) without the token ever reaching a browser that only asked to
 * render the page. Uncovering it is {@link revealDeployHook}, one deliberate call.
 *
 * Read-only and non-secret, so it carries no capability gate of its own: the
 * settings page it feeds is already behind the app's own read gate.
 */
export async function deployHookUrlMasked(appId: string): Promise<string> {
  return `${await hookPrefix(appId)}••••••••••••`;
}

/**
 * The app's real hook URL, minting the token on first use.
 *
 * Lazy minting is what keeps this additive: no existing app grew a live
 * credential the day the feature shipped, and one is created only when someone
 * with `configure_apps` deliberately opens the hook.
 */
export async function revealDeployHook(appId: string): Promise<string> {
  const { membership } = await requireCapability("configure_apps");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "configure_apps");

  const [row] = await getDb()
    .select({ tokenEnc: appsTable.deployHookTokenEnc })
    .from(appsTable)
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, membership.teamId)))
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
  const { membership } = await requireCapability("configure_apps");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "configure_apps");
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
  const { membership } = await requireCapability("configure_apps");
  if (!(await appInTeam(appId, membership.teamId)))
    throw new Error("App not found");
  await requireFolderCapabilityForApp(appId, "configure_apps");
  const user = (await getCurrentUser())!;
  const updated = await getDb()
    .update(appsTable)
    .set({ deployHookEnabled: value, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, membership.teamId)))
    .returning({ id: appsTable.id });
  if (updated.length === 0) throw new Error("App not found");
  await recordActivity(
    "app",
    value ? "Enabled the deploy hook" : "Disabled the deploy hook",
    user.name,
    appId,
  );
}

/** Why a hook call was refused — the endpoint maps these onto status codes. */
export type DeployHookRejection = "not-found" | "disabled" | "bad-token";

/**
 * Check a hook call's URL token against the stored one.
 *
 * The AUTHENTICATOR, not a gated read — like `authenticateToken` for bearer
 * tokens, it runs before any identity exists and therefore takes no capability.
 * It answers one question: does this URL segment belong to this app, and is the
 * hook open? WHO may deploy is decided after, by the bearer token the caller
 * also has to present (the route re-enters the normal gates through
 * `runWithIdentity` + `redeploy`, so the team scope, the folder gate, the
 * capability and the 2FA policy all apply unchanged).
 */
export async function verifyDeployHookToken(
  appId: string,
  token: string,
): Promise<{ ok: true; teamId: string } | { ok: false; reason: DeployHookRejection }> {
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
