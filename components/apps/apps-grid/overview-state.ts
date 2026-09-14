import type { RuntimeSnapshot } from "@/lib/apps/display-status";
import type { AppStatus } from "@/lib/types/app";

export type OverviewRuntimeView = RuntimeSnapshot & {
  maxRestartCount: number;
  unhealthyContainers: string[];
};

export type OverviewAppStateView = {
  appId: string;
  status: AppStatus;
  neverDeployed: boolean;
  runtime: OverviewRuntimeView | null;
};
