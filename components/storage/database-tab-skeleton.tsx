"use client";

import { useFlatPathname } from "@/lib/nav";
import OverviewLoading from "@/app/(dashboard)/[team]/storage/databases/[id]/loading";
import ActivityLoading from "@/app/(dashboard)/[team]/storage/databases/[id]/activity/loading";
import BackupsLoading from "@/app/(dashboard)/[team]/storage/databases/[id]/backups/loading";
import CronJobsLoading from "@/app/(dashboard)/[team]/storage/databases/[id]/cron-jobs/loading";
import MonitoringLoading from "@/app/(dashboard)/[team]/storage/databases/[id]/monitoring/loading";
import LogsLoading from "@/app/(dashboard)/[team]/storage/databases/[id]/logs/loading";
import ConsoleLoading from "@/app/(dashboard)/[team]/storage/databases/[id]/console/loading";

const TABS: Record<string, () => React.ReactNode> = {
  "": OverviewLoading,
  activity: ActivityLoading,
  backups: BackupsLoading,
  "cron-jobs": CronJobsLoading,
  monitoring: MonitoringLoading,
  logs: LogsLoading,
  console: ConsoleLoading,
};

/** The loading state of whichever database tab the address names, reused from the tab itself. */
export function DatabaseTabSkeleton() {
  const pathname = useFlatPathname();
  const tab =
    /^\/storage\/databases\/[^/]+\/?([^/]*)/.exec(pathname)?.[1] ?? "";
  const Tab = TABS[tab];
  return Tab ? <Tab /> : <div aria-busy />;
}
