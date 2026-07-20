import "server-only";

import { getDb } from "../db/client";
import { monitoringSettings } from "../db/schema/control-plane";
import { assertUser, getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { clearMetricsHistory } from "../monitoring/history";
import { clearContainerHistory } from "../monitoring/container-history";

/**
 * Monitoring settings — the instance-wide singleton behind the Monitoring page's
 * "Save metrics on server" switch (see the `monitoring_settings` table comment for
 * why it is fleet-scoped like the cleanup policy, not team-scoped).
 */
export interface MonitoringSettings {
  /** Keep a rolling in-memory metrics history per server on the control plane. */
  saveMetrics: boolean;
  /** Null until the row has been written once (the defaults are in effect). */
  updatedAt: string | null;
}

/** The singleton row's fixed PK. */
const SETTINGS_ID = "default";

/**
 * DEFAULT ON: keeping ~15 minutes of numbers in RAM costs ~0.5 MB per server and
 * makes the Monitoring page behave the way a non-expert expects (reload the page,
 * the charts are still there) — the mission's favor-automatic-over-manual call.
 */
const DEFAULTS: MonitoringSettings = { saveMetrics: true, updatedAt: null };

/** Missing row = never configured = the defaults, like `notification_settings`. */
async function loadSettings(): Promise<MonitoringSettings> {
  const rows = await getDb().select().from(monitoringSettings).limit(1);
  const row = rows[0];
  return row
    ? { saveMetrics: row.saveMetrics, updatedAt: row.updatedAt }
    : DEFAULTS;
}

/** The settings, for the Monitoring page (any logged-in member: the value only
 *  says how the page behaves — flipping it stays `manage_infra`, below). */
export async function getMonitoringSettings(): Promise<MonitoringSettings> {
  await assertUser();
  return loadSettings();
}

/* ------------------------------------------------------------------ */
/* Poll-path memo                                                      */
/* ------------------------------------------------------------------ */

/**
 * The live dashboard poll asks "is saving on?" once per second per viewer; memoise
 * the boolean briefly so that question doesn't add a SELECT to every poll. A write
 * through {@link setSaveMetrics} busts it in-process; another module graph (or a
 * second control-plane instance) converges within the TTL — for a switch whose
 * effect is "does the buffer keep growing", seconds of staleness are harmless.
 */
const MEMO_TTL_MS = 10_000;
let memo: { value: boolean; at: number } | null = null;

export async function isMetricsSavingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_TTL_MS) return memo.value;
  const { saveMetrics } = await loadSettings();
  memo = { value: saveMetrics, at: now };
  return saveMetrics;
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

/**
 * Flip "save metrics on server". Instance-wide infra, so `manage_infra` — the same
 * gate as the cleanup policy. Turning it OFF also DROPS what is buffered: the
 * switch says "save", so off must mean nothing stays saved, not "stops growing".
 */
export async function setSaveMetrics(enabled: boolean): Promise<MonitoringSettings> {
  const { teamId } = await requireCapability("manage_infra");
  const user = (await getCurrentUser())!;

  const now = nowIso();
  await getDb()
    .insert(monitoringSettings)
    .values({ id: SETTINGS_ID, saveMetrics: enabled, updatedAt: now })
    // The PK is a literal, so this upsert IS the whole write path (cleanup-policy
    // pattern): two concurrent saves settle on one row.
    .onConflictDoUpdate({
      target: monitoringSettings.id,
      set: { saveMetrics: enabled, updatedAt: now },
    });

  memo = { value: enabled, at: Date.now() };
  if (!enabled) {
    clearMetricsHistory();
    clearContainerHistory();
  }

  await recordActivity(
    "monitoring",
    enabled
      ? "Enabled saving server metrics on the control plane"
      : "Disabled saving server metrics (buffered history dropped)",
    user.name,
    null,
    teamId,
  );
  return loadSettings();
}

/** Test-only: forget the poll-path memo. */
export function __resetMonitoringSettingsMemo(): void {
  memo = null;
}
