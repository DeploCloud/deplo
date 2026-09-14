import "server-only";

import {
  and,
  count,
  countDistinct,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
} from "drizzle-orm";

import { getDb } from "../../db/client";
import { apiTokens } from "../../db/schema/control-plane/api-tokens";
import { apps } from "../../db/schema/control-plane/apps";
import { registrationLinks } from "../../db/schema/control-plane/identity";
import {
  gitConnections,
  githubApps,
} from "../../db/schema/control-plane/integrations";
import { pushSubscriptions } from "../../db/schema/control-plane/notifications";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { passkey, session } from "../../db/schema/auth";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import { passkeyRelyingParty } from "../../public-url";
import { panelFallbackHost } from "../../deploy/domains";
import {
  deploHostServer,
  instancePublicBaseUrl,
  loadSettings,
  reachableHostIp,
} from "./settings-store";
import { hostOf, normalizePanelUrl, schemeOf } from "./panel-address";

// What moving the panel to `url` would break, counted live and instance-wide.
export type PanelAddressImpact = {
  // The address as it would be stored, normalised the same way the save does.
  url: string;
  currentUrl: string;
  // Whether the hostname moves. Everything origin-bound dies on this.
  hostChanges: boolean;
  // Whether http/https changes. An origin change too, and https->https is not one.
  schemeChanges: boolean;
  // https -> http specifically: the browser remembers the old HSTS either way.
  losesHttps: boolean;
  // The address that keeps working through all of it, when there is one.
  panelFallbackUrl: string | null;
  // Passkeys welded to the address as it is now, and how many accounts hold them.
  passkeys: number;
  passkeyPeople: number;
  // Live sessions, and the people behind them, who will have to sign in again.
  sessions: number;
  sessionPeople: number;
  // Deploy hooks whose URL is already pasted into somebody else's CI.
  deployHooks: number;
  // AI clients connected over MCP, which have to be reconnected.
  mcpConnections: number;
  // Registration links already handed out. Repairable: the same link re-renders.
  registrationLinks: number;
  // Servers whose install command was issued but never run. Repairable.
  pendingServers: number;
  // Browser notification subscriptions, which are per-origin.
  pushSubscriptions: number;
  // Git connections and GitHub Apps, pinned to the INSTALLER's address, not this one.
  gitConnections: number;
  githubApps: number;
};

export async function getPanelAddressImpact(
  input: string,
): Promise<PanelAddressImpact> {
  await requireInstanceAdmin();
  const url = normalizePanelUrl(input);
  const currentUrl = await instancePublicBaseUrl();
  const base: PanelAddressImpact = {
    url,
    currentUrl,
    hostChanges: hostOf(url) !== hostOf(currentUrl),
    schemeChanges: schemeOf(url) !== schemeOf(currentUrl),
    losesHttps: schemeOf(currentUrl) === "https:" && schemeOf(url) === "http:",
    panelFallbackUrl: null,
    passkeys: 0,
    passkeyPeople: 0,
    sessions: 0,
    sessionPeople: 0,
    deployHooks: 0,
    mcpConnections: 0,
    registrationLinks: 0,
    pendingServers: 0,
    pushSubscriptions: 0,
    gitConnections: 0,
    githubApps: 0,
  };
  const host = await deploHostServer();
  const hostIp = reachableHostIp(host);
  base.panelFallbackUrl =
    hostIp && !(await loadSettings()).panelFallbackDisabled
      ? `https://${panelFallbackHost(hostIp)}`
      : null;
  // Same address, nothing to warn about. Counting anyway would put a wall of
  // red in front of a save that changes nothing.
  if (!base.hostChanges && !base.schemeChanges) return base;

  const db = getDb();
  // Null when this instance cannot have passkeys at all (no address, or plain
  // http): then there are none to lose, rather than "none matched".
  const rp = passkeyRelyingParty();
  const now = nowIso();
  const [
    passkeys,
    sessions,
    deployHooks,
    mcp,
    links,
    pending,
    push,
    gitConns,
    ghApps,
  ] = await Promise.all([
    rp
      ? db
          .select({ n: count(), people: countDistinct(passkey.userId) })
          .from(passkey)
          .where(eq(passkey.rpId, rp.rpId))
      : Promise.resolve([{ n: 0, people: 0 }]),
    db
      .select({ n: count(), people: countDistinct(session.userId) })
      .from(session)
      .where(gt(session.expiresAt, new Date())),
    db
      .select({ n: count() })
      .from(apps)
      .where(
        and(
          isNotNull(apps.deployHookTokenEnc),
          eq(apps.deployHookEnabled, true),
        ),
      ),
    db
      .select({ n: count() })
      .from(apiTokens)
      .where(isNotNull(apiTokens.oauthClientId)),
    db
      .select({ n: count() })
      .from(registrationLinks)
      .where(
        and(
          eq(registrationLinks.status, "pending"),
          gte(registrationLinks.expiresAt, now),
        ),
      ),
    db
      .select({ n: count() })
      .from(serversTable)
      .where(
        and(
          isNotNull(serversTable.bootstrapTokenHash),
          isNull(serversTable.bootstrapUsedAt),
        ),
      ),
    db.select({ n: count() }).from(pushSubscriptions),
    db.select({ n: count() }).from(gitConnections),
    db.select({ n: count() }).from(githubApps),
  ]);

  return {
    ...base,
    passkeys: Number(passkeys[0]?.n ?? 0),
    passkeyPeople: Number(passkeys[0]?.people ?? 0),
    sessions: Number(sessions[0]?.n ?? 0),
    sessionPeople: Number(sessions[0]?.people ?? 0),
    deployHooks: Number(deployHooks[0]?.n ?? 0),
    mcpConnections: Number(mcp[0]?.n ?? 0),
    registrationLinks: Number(links[0]?.n ?? 0),
    pendingServers: Number(pending[0]?.n ?? 0),
    pushSubscriptions: Number(push[0]?.n ?? 0),
    gitConnections: Number(gitConns[0]?.n ?? 0),
    githubApps: Number(ghApps[0]?.n ?? 0),
  };
}

// What an address change cost, said in the trail rather than only in a dialog.
export function passkeyLossSuffix(lost: number): string {
  if (lost <= 0) return "";
  return ` (${lost} passkey${lost === 1 ? "" : "s"} stopped working)`;
}

// How many passkeys this address currently holds, for the Activity entry.
export async function passkeysBoundToThisAddress(): Promise<number> {
  const rp = passkeyRelyingParty();
  if (!rp) return 0;
  const [row] = await getDb()
    .select({ n: count() })
    .from(passkey)
    .where(eq(passkey.rpId, rp.rpId));
  return Number(row?.n ?? 0);
}
