import "server-only";

import { getDb } from "../db/client";
import { monitoringSettings } from "../db/schema/control-plane/instance";
import { assertUser, getCurrentUser } from "../auth/current-user";
import { nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { clearMetricsHistory } from "../monitoring/history";
import { clearContainerHistory } from "../monitoring/container-history";

// MonitoringSettings is the instance-wide singleton behind "Save metrics on server".
export interface MonitoringSettings {
  /** Keep a rolling in-memory metrics history per server on the control plane. */
  saveMetrics: boolean;
  /** Null until the row has been written once (the defaults are in effect). */
  updatedAt: string | null;
}

const SETTINGS_ID = "default";

// Default ON: ~15 minutes of history costs ~0.5 MB per server, so a reload keeps the charts.
const DEFAULTS: MonitoringSettings = { saveMetrics: true, updatedAt: null };

async function loadSettings(): Promise<MonitoringSettings> {
  const rows = await getDb().select().from(monitoringSettings).limit(1);
  const row = rows[0];
  return row
    ? { saveMetrics: row.saveMetrics, updatedAt: row.updatedAt }
    : DEFAULTS;
}

// getMonitoringSettings reads the settings; any logged-in member may (flipping is gated).
export async function getMonitoringSettings(): Promise<MonitoringSettings> {
  await assertUser();
  return loadSettings();
}

// The live dashboard poll asks "is saving on?" once per second per viewer; the memo keeps
// that question off the database.
const MEMO_TTL_MS = 10_000;
let memo: { value: boolean; at: number } | null = null;

export async function isMetricsSavingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_TTL_MS) return memo.value;
  const { saveMetrics } = await loadSettings();
  memo = { value: saveMetrics, at: now };
  return saveMetrics;
}

// setSaveMetrics flips "save metrics on server"; off also drops the buffered history.
export async function setSaveMetrics(
  enabled: boolean,
): Promise<MonitoringSettings> {
  const { teamId } = await requireCapability("manage_monitoring");
  const user = (await getCurrentUser())!;

  const now = nowIso();
  await getDb()
    .insert(monitoringSettings)
    .values({ id: SETTINGS_ID, saveMetrics: enabled, updatedAt: now })
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
