import "server-only";

import { instanceOwnerUserId } from "../data/instance-owner";
import {
  mintUsageInstanceId,
  stampUsageReportSent,
  usageReportState,
  usageReportsForcedOff,
} from "../data/instance-settings/settings-store";
import { buildUsageReport, DAY_MS, USAGE_REPORT_URL } from "./report";

const TIMEOUT_MS = 10_000;

export type UsageSendOutcome = "skipped" | "sent" | "failed";

// The maintenance sweep is the only caller (ADR-0033). Every rule that says "do not send" lives here.
export async function sendUsageReport(
  deps: { env?: NodeJS.ProcessEnv; now?: () => Date } = {},
): Promise<UsageSendOutcome> {
  const env = deps.env ?? process.env;
  const now = deps.now?.() ?? new Date();
  if (env.NODE_ENV !== "production") return "skipped";
  if (usageReportsForcedOff(env)) return "skipped";
  if (!(await instanceOwnerUserId())) return "skipped";

  const state = await usageReportState();
  if (!state.enabled) return "skipped";
  if (state.lastSentAt && now.getTime() - Date.parse(state.lastSentAt) < DAY_MS)
    return "skipped";

  const { instanceId, mintedAt } =
    state.instanceId && state.mintedAt
      ? { instanceId: state.instanceId, mintedAt: state.mintedAt }
      : await mintUsageInstanceId(now);
  const report = await buildUsageReport({ instanceId, mintedAt, now });

  let res: Response;
  try {
    res = await fetch(USAGE_REPORT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    console.warn("[deplo] usage report not sent:", e);
    return "failed";
  }
  if (res.status >= 500) {
    console.warn(`[deplo] usage report not sent: HTTP ${res.status}`);
    return "failed";
  }
  await stampUsageReportSent(now);
  return "sent";
}
