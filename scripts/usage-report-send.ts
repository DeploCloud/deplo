import { eq } from "drizzle-orm";

import { getDb } from "../lib/db/client";
import { instanceSettings } from "../lib/db/schema/control-plane/instance";
import { instanceOwnerUserId } from "../lib/data/instance-owner";
import {
  usageReportState,
  usageReportsForcedOff,
} from "../lib/data/instance-settings/settings-store";
import { buildUsageReport, USAGE_REPORT_URL } from "../lib/usage-report/report";
import { sendUsageReport } from "../lib/usage-report/send";

// The end-to-end check for DeploCloud/deplo#63: one send, now, with the rules the sweep applies.
async function main() {
  const again = process.argv.includes("--again");
  if (again)
    await getDb()
      .update(instanceSettings)
      .set({ usageReportSentAt: null })
      .where(eq(instanceSettings.id, "default"));

  const state = await usageReportState();
  console.log(
    JSON.stringify(
      {
        owner: Boolean(await instanceOwnerUserId()),
        enabled: state.enabled,
        forcedOff: usageReportsForcedOff(),
        lastSentAt: state.lastSentAt,
        instanceId: state.instanceId,
        url: USAGE_REPORT_URL,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify(
      await buildUsageReport({
        instanceId: state.instanceId,
        mintedAt: state.mintedAt,
      }),
      null,
      2,
    ),
  );
  const outcome = await sendUsageReport({
    env: { ...process.env, NODE_ENV: "production" },
  });
  console.log(`outcome: ${outcome}`);
  process.exit(outcome === "failed" ? 1 : 0);
}

void main();
