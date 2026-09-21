import "server-only";

import { randomUUID } from "node:crypto";

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
import { gravatarEnabled } from "../../avatar";

export const SETTINGS_ID = "default";

export type PanelAddressSource = "stored" | "environment" | "request";

export type InstanceSettings = {
  panelUrl: string;
  panelUrlSource: PanelAddressSource;
  storedPanelUrl: string | null;
  panelFallbackUrl: string | null;
  panelFallbackDisabled: boolean;
  deploHostIp: string | null;
  logMaxDays: number;
  gravatarEnabled: boolean;
  usageReportsEnabled: boolean;
  usageReportsForcedOff: boolean;
  usageReportLastSentAt: string | null;
  version: string;
  deploHostId: string | null;
  deploHostName: string | null;
  ownerName: string | null;
};

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
      logMaxDays: row?.logMaxDays ?? DEFAULT_LOG_RANGE_DAYS,
    };
  },
);

export async function logMaxDays(): Promise<number> {
  const { logMaxDays } = await loadSettings();
  return clampLogMaxDays(logMaxDays);
}

function clampLogMaxDays(days: number): number {
  return Number.isFinite(days)
    ? Math.min(
        MAX_LOG_RANGE_DAYS,
        Math.max(MIN_LOG_RANGE_DAYS, Math.trunc(days)),
      )
    : DEFAULT_LOG_RANGE_DAYS;
}

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

export type UsageReportState = {
  enabled: boolean;
  instanceId: string | null;
  mintedAt: string | null;
  lastSentAt: string | null;
};

// https://consoledonottrack.com - the install-time kill switch, and the only one (ADR-0033).
export function usageReportsForcedOff(env = process.env): boolean {
  const v = env.DO_NOT_TRACK?.trim().toLowerCase();
  return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

export async function usageReportState(): Promise<UsageReportState> {
  const [row] = await getDb()
    .select({
      enabled: instanceSettings.usageReportsEnabled,
      instanceId: instanceSettings.usageInstanceId,
      mintedAt: instanceSettings.usageInstanceIdMintedAt,
      lastSentAt: instanceSettings.usageReportSentAt,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  return {
    enabled: row?.enabled ?? true,
    instanceId: row?.instanceId ?? null,
    mintedAt: row?.mintedAt ?? null,
    lastSentAt: row?.lastSentAt ?? null,
  };
}

// Ungated on purpose: the maintenance sweep runs with no identity and is the only caller.
export async function mintUsageInstanceId(
  now: Date,
): Promise<{ instanceId: string; mintedAt: string }> {
  const instanceId = randomUUID();
  const mintedAt = now.toISOString();
  await getDb()
    .insert(instanceSettings)
    .values({
      id: SETTINGS_ID,
      usageInstanceId: instanceId,
      usageInstanceIdMintedAt: mintedAt,
      updatedAt: mintedAt,
    })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { usageInstanceId: instanceId, usageInstanceIdMintedAt: mintedAt },
    });
  return { instanceId, mintedAt };
}

export async function stampUsageReportSent(now: Date): Promise<void> {
  await getDb()
    .update(instanceSettings)
    .set({ usageReportSentAt: now.toISOString() })
    .where(eq(instanceSettings.id, SETTINGS_ID));
}

export async function setUsageReportsEnabled(
  enabled: boolean,
): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;

  const now = nowIso();
  // Off severs the history: the next on mints a fresh id at the first send.
  const patch = enabled
    ? { usageReportsEnabled: true }
    : {
        usageReportsEnabled: false,
        usageInstanceId: null,
        usageInstanceIdMintedAt: null,
      };
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, ...patch, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { ...patch, updatedAt: now },
    });

  await recordActivity(
    "instance",
    enabled
      ? "Turned on anonymous usage statistics"
      : "Turned off anonymous usage statistics",
    user.name,
    null,
    teamId,
  );
  return getInstanceSettings();
}

export async function instancePublicBaseUrl(h?: Headers): Promise<string> {
  const { panelUrl } = await loadSettings();
  if (!h) {
    try {
      h = await headers();
    } catch {}
  }
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

export function reachableHostIp(host: { ip?: string } | null): string | null {
  const candidate = host?.ip?.trim() || instanceHost();
  if (!isIpv4(candidate)) return null;
  return candidate.startsWith("127.") ? null : candidate;
}

export async function getInstanceSettings(): Promise<InstanceSettings> {
  await requireInstanceAdmin();
  const { panelUrl, logMaxDays, panelFallbackDisabled } = await loadSettings();
  const [host, ownerName, usage] = await Promise.all([
    deploHostServer(),
    instanceOwnerName(),
    usageReportState(),
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
    usageReportsEnabled: usage.enabled,
    usageReportsForcedOff: usageReportsForcedOff(),
    usageReportLastSentAt: usage.lastSentAt,
    version: DEPLO_VERSION,
    deploHostId: host?.id ?? null,
    deploHostName: host ? serverLabel(host) : null,
    ownerName,
  };
}

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
  const { reconcileOAuthResources } =
    await import("../../auth/oauth-resources");
  await reconcileOAuthResources();
}

export async function hydratePublicBaseUrl(): Promise<void> {
  const [row] = await getDb()
    .select({ panelUrl: instanceSettings.panelUrl })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  setStoredPublicBaseUrl(row?.panelUrl ?? null);
}
