import "server-only";

import { requireInstanceAdmin } from "../membership";
import { usageReportState } from "./instance-settings/settings-store";
import { buildUsageReport } from "../usage-report/report";

export interface UsageReportPreview {
  json: string;
  instanceId: string | null;
  lastSentAt: string | null;
}

export async function previewUsageReport(): Promise<UsageReportPreview> {
  await requireInstanceAdmin();
  const state = await usageReportState();
  const report = await buildUsageReport({
    instanceId: state.instanceId,
    mintedAt: state.mintedAt,
  });
  return {
    json: JSON.stringify(report, null, 2),
    instanceId: state.instanceId,
    lastSentAt: state.lastSentAt,
  };
}
