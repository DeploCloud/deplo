import "server-only";

// https://deplo.build/docs/operations/instance-administration

import { cache } from "@/lib/request-cache";
import { eq } from "drizzle-orm";
import { headers } from "next/headers";

import { getDb } from "../../db/client";
import { users } from "../../db/schema/control-plane/identity";
import { instanceSettings } from "../../db/schema/control-plane/instance";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import {
  DEFAULT_LOG_RANGE_DAYS,
  MAX_LOG_RANGE_DAYS,
  MIN_LOG_RANGE_DAYS,
} from "../../types/deployment";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import {
  requestOrigin,
  resolvePublicBaseUrl,
  setStoredPublicBaseUrl,
} from "../../public-url";
import {
  deploHostSelfAddresses,
  instanceHost,
  isDeploHostServer,
  isIpv4,
  panelFallbackHost,
} from "../../deploy/domains";
import { DEPLO_VERSION } from "../../version";
import { serverLabel } from "../../utils";
import { recordActivity } from "../activity";
import { instanceOwnerUserId } from "../instance-owner";
// The flag itself lives in the leaf `lib/avatar.ts`: this module imports
// `getCurrentUser` from `lib/auth`, and `lib/auth` needs the flag for its own DTO.
import { gravatarEnabled } from "../../avatar";

// The singleton row's PK. See the `instance_settings` table comment.
export const SETTINGS_ID = "default";

export type PanelAddressSource = "stored" | "environment" | "request";

export type InstanceSettings = {
  panelUrl: string;
  // Where that came from: only one of the three is editable here.
  panelUrlSource: PanelAddressSource;
  // The stored override, or null when nothing has been set here.
  storedPanelUrl: string | null;
  // The generated `https://deplo-<hexip>.nip.io` this panel also answers on. Null
  // only when Deplo cannot work out an address of its own anyone else could reach.
  panelFallbackUrl: string | null;
  // Whether the operator turned that address off. The address above is then what
  // turning it back on would restore, not somewhere the panel answers.
  panelFallbackDisabled: boolean;
  // The IPv4 an A record for the panel's domain should point at.
  deploHostIp: string | null;
  // How far back the log viewer's time range may reach, in days.
  logMaxDays: number;
  // Whether a person with no uploaded picture falls back to their Gravatar.
  gravatarEnabled: boolean;
  version: string;
  // The server running the panel, when it is one Deplo knows about.
  deploHostId: string | null;
  deploHostName: string | null;
  // Who owns this instance, or null on one that is unowned.
  ownerName: string | null;
};

// The stored row, ungated and per-request cached.
export const loadSettings = cache(
  async (): Promise<{
    panelUrl: string | null;
    logMaxDays: number;
    panelFallbackDisabled: boolean;
  }> => {
    const [row] = await getDb()
      .select({
        panelUrl: instanceSettings.panelUrl,
        logMaxDays: instanceSettings.logMaxDays,
        panelFallbackDisabled: instanceSettings.panelFallbackDisabled,
      })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, SETTINGS_ID));
    return {
      panelUrl: row?.panelUrl ?? null,
      panelFallbackDisabled: row?.panelFallbackDisabled ?? false,
      // No row at all is a fresh instance, which gets the same default the column
      // does rather than a 0 that would collapse the picker.
      logMaxDays: row?.logMaxDays ?? DEFAULT_LOG_RANGE_DAYS,
    };
  },
);

// How far back the log viewer's time range may reach, in days.
export async function logMaxDays(): Promise<number> {
  const { logMaxDays } = await loadSettings();
  return clampLogMaxDays(logMaxDays);
}

// Clamp, never reject: anything outside the field's own bounds arrived from an
// API client, and the honest answer to "keep 900 days" is the ceiling.
function clampLogMaxDays(days: number): number {
  return Number.isFinite(days)
    ? Math.min(
        MAX_LOG_RANGE_DAYS,
        Math.max(MIN_LOG_RANGE_DAYS, Math.trunc(days)),
      )
    : DEFAULT_LOG_RANGE_DAYS;
}

// Set the log viewer's maximum time range. Instance-wide because the logs live on
// the HOST, which several teams share.
export async function setLogMaxDays(days: number): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const value = clampLogMaxDays(days);
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, logMaxDays: value, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { logMaxDays: value, updatedAt: now },
    });

  await recordActivity(
    "instance",
    `Set the maximum log range to ${value} ${value === 1 ? "day" : "days"}`,
    user.name,
    null,
    teamId,
  );
  return getInstanceSettings();
}

// Turn Gravatar fallback on or off for the whole instance. Off stops the data
// layer emitting the URL; the panel itself never dials out either way.
export async function setGravatarEnabled(
  enabled: boolean,
): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, gravatarEnabled: enabled, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { gravatarEnabled: enabled, updatedAt: now },
    });

  await recordActivity(
    "instance",
    enabled
      ? "Turned on Gravatar profile pictures"
      : "Turned off Gravatar profile pictures",
    user.name,
    null,
    teamId,
  );
  return getInstanceSettings();
}

// This instance's public base URL, as everything Deplo hands out should spell it.
export async function instancePublicBaseUrl(h?: Headers): Promise<string> {
  const { panelUrl } = await loadSettings();
  if (!h) {
    try {
      h = await headers();
    } catch {
      // Outside a request scope (a scheduler tick, a background sweep) there are
      // no headers to read; the configured address, or the placeholder, answers.
    }
  }
  // Before a takeover's cutover the configured address answers nothing - Deplo's
  // proxy waits on loopback - and the one this request arrived on is the old
  // panel's proxy, the only address a remote machine can enrol through.
  if (h) {
    const { takeoverAwaitsCutover } = await import("../takeover");
    if (await takeoverAwaitsCutover()) {
      const origin = requestOrigin(h);
      if (origin) return origin;
    }
  }
  if (panelUrl) return panelUrl;
  return resolvePublicBaseUrl(h ?? new Headers());
}

// The server this panel runs on, when it is one Deplo knows about.
export async function deploHostServer() {
  const { listAllServers } = await import("../servers/roster");
  const servers = await listAllServers();
  const selfAddresses = deploHostSelfAddresses();
  return servers.find((s) => isDeploHostServer(s, selfAddresses)) ?? null;
}

async function instanceOwnerName(): Promise<string | null> {
  const ownerId = await instanceOwnerUserId();
  if (!ownerId) return null;
  const rows = await getDb()
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return rows[0]?.name ?? null;
}

// The IPv4 an outsider can reach this panel's machine on, or null. Loopback is
// "no answer": an address nobody else can dial reads as a promise.
export function reachableHostIp(host: { ip?: string } | null): string | null {
  const candidate = host?.ip?.trim() || instanceHost();
  if (!isIpv4(candidate)) return null;
  return candidate.startsWith("127.") ? null : candidate;
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const { panelUrl, logMaxDays, panelFallbackDisabled } = await loadSettings();
  const [host, ownerName] = await Promise.all([
    deploHostServer(),
    instanceOwnerName(),
  ]);
  const hostIp = reachableHostIp(host);

  return {
    panelUrl: panelUrl ?? (await instancePublicBaseUrl()),
    panelFallbackUrl: hostIp ? `https://${panelFallbackHost(hostIp)}` : null,
    panelFallbackDisabled,
    deploHostIp: hostIp,
    panelUrlSource: panelUrl
      ? "stored"
      : process.env.DEPLO_PUBLIC_URL?.trim()
        ? "environment"
        : "request",
    storedPanelUrl: panelUrl,
    logMaxDays: clampLogMaxDays(logMaxDays),
    gravatarEnabled: await gravatarEnabled(),
    version: DEPLO_VERSION,
    deploHostId: host?.id ?? null,
    deploHostName: host ? serverLabel(host) : null,
    ownerName,
  };
}

// Store the address AND publish it to the two consumers that cannot await a
// database read: the URL builder and Better Auth.
export async function rememberPanelUrl(url: string | null): Promise<void> {
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, panelUrl: url, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { panelUrl: url, updatedAt: now },
    });
  setStoredPublicBaseUrl(url);
  const { resetAuth } = await import("../../auth/better-auth");
  resetAuth();
  // The OAuth audience is `<base>/api/mcp`, so moving the panel mints a NEW resource
  // identifier and leaves the old row behind (seeding is insertOnly).
  const { reconcileOAuthResources } =
    await import("../../auth/oauth-resources");
  await reconcileOAuthResources();
}

// Load the stored address into the in-memory copy the synchronous consumers read.
// Called once at boot, before this instance serves a request.
export async function hydratePublicBaseUrl(): Promise<void> {
  const [row] = await getDb()
    .select({ panelUrl: instanceSettings.panelUrl })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  setStoredPublicBaseUrl(row?.panelUrl ?? null);
}
