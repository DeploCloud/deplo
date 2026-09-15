import "server-only";

import { getDb } from "../db/client";
import { monitoringSettings } from "../db/schema/control-plane/instance";
import { assertUser, getCurrentUser } from "../auth/current-user";
import { nowIso } from "../ids";
import { requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { clearMetricsHistory } from "../monitoring/history";
import { clearContainerHistory } from "../monitoring/container-history";

export interface MonitoringSettings {
  saveMetrics: boolean;
  updatedAt: string | null;
}

const SETTINGS_ID = "default";

const DEFAULTS: MonitoringSettings = { saveMetrics: true, updatedAt: null };

async function loadSettings(): Promise<MonitoringSettings> {
  const rows = await getDb().select().from(monitoringSettings).limit(1);
  const row = rows[0];
  return row
    ? { saveMetrics: row.saveMetrics, updatedAt: row.updatedAt }
    : DEFAULTS;
}

export async function getMonitoringSettings(): Promise<MonitoringSettings> {
  await assertUser();
  return loadSettings();
}

const MEMO_TTL_MS = 10_000;
let memo: { value: boolean; at: number } | null = null;

export async function isMetricsSavingEnabled(): Promise<boolean> {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_TTL_MS) return memo.value;
  const { saveMetrics } = await loadSettings();
  memo = { value: saveMetrics, at: now };
  return saveMetrics;
}

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

export function __resetMonitoringSettingsMemo(): void {
  memo = null;
}
