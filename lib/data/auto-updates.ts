import "server-only";

import { eq } from "drizzle-orm";

import { getCurrentUser } from "../auth/current-user";
import { getDb } from "../db/client";
import { instanceSettings } from "../db/schema/control-plane/instance";
import { nowIso } from "../ids";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { installsAt } from "../auto-updates/decide";
import { nextSlotAt, wallClock, windowEndAfter } from "../auto-updates/window";
import { canonicalTimezone } from "./server-maintenance";
import { recordActivity } from "./activity";
import {
  deploHostServer,
  SETTINGS_ID,
} from "./instance-settings/settings-store";
import { canaryReleasesEnabled } from "./release-channel";
import {
  logUpdateEvent,
  readUpdateLog,
  type UpdateLogEntry,
} from "./update-log";
import { getUpdateInfo, type UpdateInfo } from "./updates";

// https://deplo.build/docs/operations/update#automatic-updates
export function autoUpdatesForcedOff(env = process.env): boolean {
  const v = env.DEPLO_AUTO_UPDATE?.trim().toLowerCase();
  return v === "off" || v === "false" || v === "0" || v === "no";
}

export interface AutoUpdateSettings {
  enabled: boolean;
  hour: number;
  timezone: string | null;
  postponedUntil: string | null;
}

export async function readAutoUpdateSettings(): Promise<AutoUpdateSettings> {
  const [row] = await getDb()
    .select({
      enabled: instanceSettings.autoUpdatesEnabled,
      hour: instanceSettings.autoUpdateHour,
      timezone: instanceSettings.autoUpdateTimezone,
      postponedUntil: instanceSettings.autoUpdatePostponedUntil,
    })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  return (
    row ?? { enabled: true, hour: 2, timezone: null, postponedUntil: null }
  );
}

async function writeSettings(
  patch: Partial<typeof instanceSettings.$inferInsert>,
) {
  const now = nowIso();
  await getDb()
    .insert(instanceSettings)
    .values({ id: SETTINGS_ID, ...patch, updatedAt: now })
    .onConflictDoUpdate({
      target: instanceSettings.id,
      set: { ...patch, updatedAt: now },
    });
}

const UTC_LIKE = /^(etc\/)?(utc|uct|gmt|universal|zulu|greenwich)([+-]0)?$/i;
export const isUtcLike = (tz: string) => UTC_LIKE.test(tz);

const HOST_TZ = Symbol.for("deplo.auto-updates.host-timezone");
const HOST_TZ_MS = 60 * 60_000;
const cache = globalThis as unknown as {
  [HOST_TZ]?: { at: number; zone: string | null };
};

export function __resetHostTimezoneForTest(zone?: string | null): void {
  cache[HOST_TZ] = zone === undefined ? undefined : { at: Date.now(), zone };
}

// The panel's own clock is UTC in its container: the machine's zone comes from its server agent.
async function hostTimezone(): Promise<string | null> {
  const hit = cache[HOST_TZ];
  if (hit && Date.now() - hit.at < HOST_TZ_MS) return hit.zone;
  let zone: string | null = null;
  const server = await deploHostServer();
  if (server) {
    const { fetchHostInfo } = await import("../infra/agent-client/host-ops");
    const info = await fetchHostInfo(server.id).catch(() => null);
    zone = info ? canonicalTimezone(info.timezone) : null;
  }
  cache[HOST_TZ] = { at: Date.now(), zone };
  return zone;
}

export type TimezoneSource = "set" | "server" | "default";

/** The zone the window is read in: the admin's choice, else the server's, else UTC. */
export async function autoUpdateTimezone(
  stored: string | null,
): Promise<{ zone: string; source: TimezoneSource }> {
  if (stored) return { zone: stored, source: "set" };
  const host = await hostTimezone();
  if (host && !isUtcLike(host)) return { zone: host, source: "server" };
  return { zone: "UTC", source: "default" };
}

export type AutoUpdateBlock = "provider" | "canary" | "host";

// Each one keeps the admin's choice and only pauses it.
async function autoUpdateBlock(): Promise<AutoUpdateBlock | null> {
  if (autoUpdatesForcedOff()) return "provider";
  if (await canaryReleasesEnabled()) return "canary";
  if (!(await deploHostServer())) return "host";
  return null;
}

export interface AutoUpdatePlan {
  settings: AutoUpdateSettings;
  timezone: string;
  timezoneSource: TimezoneSource;
  blockedBy: AutoUpdateBlock | null;
  log: UpdateLogEntry[];
  info: UpdateInfo;
}

/** Everything a tick or the Updates tab reads before deciding anything. Ungated. */
export async function autoUpdatePlan(
  info?: UpdateInfo,
): Promise<AutoUpdatePlan> {
  const settings = await readAutoUpdateSettings();
  const [tz, blockedBy, log, update] = await Promise.all([
    autoUpdateTimezone(settings.timezone),
    autoUpdateBlock(),
    readUpdateLog(),
    info ?? getUpdateInfo(),
  ]);
  return {
    settings,
    timezone: tz.zone,
    timezoneSource: tz.source,
    blockedBy,
    log: log.filter((e) => e.trigger === "automatic"),
    info: update,
  };
}

export interface AutoUpdateStatus {
  enabled: boolean;
  blockedBy: AutoUpdateBlock | null;
  hour: number;
  timezone: string;
  timezoneSource: TimezoneSource;
  // When the waiting update installs itself; null with nothing waiting, or one an admin has to install.
  installsAt: string | null;
  nextCheckAt: string | null;
  heldReason: string | null;
  postponedUntil: string | null;
  postponedBy: string | null;
  postponedTimes: number;
}

export function statusFromPlan(
  p: AutoUpdatePlan,
  now = new Date(),
): AutoUpdateStatus {
  const { settings, info } = p;
  const active = settings.enabled && p.blockedBy === null;
  const next = info.next;
  const mine = next ? p.log.filter((e) => e.toVersion === next) : [];
  const held = mine.find((e) => e.outcome === "held")?.reason ?? null;
  const postponed =
    settings.postponedUntil &&
    Date.parse(settings.postponedUntil) > now.getTime()
      ? settings.postponedUntil
      : null;
  const postponements = mine.filter((e) => e.outcome === "postponed");
  const at = installsAt({
    now,
    hour: settings.hour,
    timezone: p.timezone,
    active,
    postponedUntil: postponed,
    next,
    nextPublishedAt: info.nextPublishedAt,
    securityFix: info.securityFix !== null,
    manualUpdate: info.manualUpdate,
    log: p.log,
  });
  const check = active
    ? nextSlotAt(
        new Date(Math.max(now.getTime(), Date.parse(postponed ?? "") || 0)),
        settings.hour,
        p.timezone,
      )
    : null;
  return {
    enabled: settings.enabled,
    blockedBy: p.blockedBy,
    hour: settings.hour,
    timezone: p.timezone,
    timezoneSource: p.timezoneSource,
    installsAt: at?.toISOString() ?? null,
    nextCheckAt: check?.toISOString() ?? null,
    heldReason: active && next ? (info.manualUpdate ?? held) : null,
    postponedUntil: postponed,
    postponedBy: postponed
      ? (postponements.sort((a, b) => b.at.localeCompare(a.at))[0]?.actor ??
        null)
      : null,
    postponedTimes: postponements.length,
  };
}

export async function readAutoUpdateStatus(
  info?: UpdateInfo,
): Promise<AutoUpdateStatus> {
  await requireInstanceAdmin();
  return statusFromPlan(await autoUpdatePlan(info));
}

async function actor() {
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  return { teamId, name: user.name };
}

export async function setAutoUpdates(input: {
  enabled?: boolean | null;
  hour?: number | null;
  timezone?: string | null;
}): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  const by = await actor();
  const before = await readAutoUpdateSettings();
  const patch: Partial<typeof instanceSettings.$inferInsert> = {};
  if (input.hour != null) {
    if (!Number.isInteger(input.hour) || input.hour < 0 || input.hour > 23)
      throw new Error("Pick an hour from 00:00 to 23:00.");
    patch.autoUpdateHour = input.hour;
  }
  if (input.timezone != null) {
    // Empty goes back to following the machine's own timezone.
    const tz = input.timezone.trim() ? canonicalTimezone(input.timezone) : "";
    if (tz === null)
      throw new Error(
        `${input.timezone.trim()} is not a timezone. Pick one from the list, like "Europe/Rome".`,
      );
    patch.autoUpdateTimezone = tz || null;
  }
  if (input.enabled != null) patch.autoUpdatesEnabled = input.enabled;
  if (Object.keys(patch).length === 0) return getUpdateInfo();
  await writeSettings(patch);

  if (input.enabled != null && input.enabled !== before.enabled)
    await recordActivity(
      "server",
      input.enabled
        ? "Turned on automatic updates of Deplo"
        : "Turned off automatic updates of Deplo",
      by.name,
      null,
      by.teamId,
    );
  const after = await readAutoUpdateSettings();
  if (after.hour !== before.hour || after.timezone !== before.timezone) {
    const tz = await autoUpdateTimezone(after.timezone);
    await recordActivity(
      "server",
      `Moved automatic updates of Deplo to ${String(after.hour).padStart(2, "0")}:00 (${tz.zone})`,
      by.name,
      null,
      by.teamId,
    );
  }
  return getUpdateInfo();
}

/** Skips the night ahead, or the one after a night already skipped. Logged, never capped. */
export async function postponeAutoUpdate(): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  const by = await actor();
  const plan = await autoUpdatePlan();
  const next = plan.info.next;
  if (!next) throw new Error("There is no update to postpone.");
  const now = new Date();
  const from = Math.max(
    now.getTime(),
    Date.parse(plan.settings.postponedUntil ?? "") || 0,
  );
  const until = windowEndAfter(
    new Date(from),
    plan.settings.hour,
    plan.timezone,
  );
  await writeSettings({ autoUpdatePostponedUntil: until.toISOString() });
  const skipped = new Date(until.getTime() - 3 * 3_600_000);
  await logUpdateEvent({
    outcome: "postponed",
    to: next,
    trigger: "automatic",
    actor: by.name,
    reason: `Skips the night of ${wallClock(skipped, plan.timezone)} (${plan.timezone}).`,
  });
  return getUpdateInfo();
}

/** The admin's browser names the zone when the machine only says UTC. Writes once, silently. */
export async function adoptAutoUpdateTimezone(
  timezone: string,
): Promise<UpdateInfo> {
  await requireInstanceAdmin();
  const tz = canonicalTimezone(timezone);
  const settings = await readAutoUpdateSettings();
  if (tz && !isUtcLike(tz) && !settings.timezone) {
    const current = await autoUpdateTimezone(null);
    if (current.source === "default")
      await writeSettings({ autoUpdateTimezone: tz });
  }
  return getUpdateInfo();
}
