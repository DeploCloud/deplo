"use client";

import {
  useLiveApp,
  useLiveStatus,
  useNeverDeployed,
} from "@/components/apps/app-live-status";
import { useAppRuntime } from "@/components/apps/use-app-runtime";
import { displayStatus, type DisplayStatus } from "@/lib/apps/display-status";
import type { AppStatus } from "@/lib/types/app";
import { detailFor, StatusIndicator } from "./app-status-dot/status-renderer";

function useDisplayStatus(fallback: AppStatus): {
  status: DisplayStatus;
  detail: string | null;
} {
  const live = useLiveApp();
  const status = useLiveStatus(fallback);
  const neverDeployed = useNeverDeployed();
  const appId = live?.id ?? "";
  const runtime = useAppRuntime(appId, {
    enabled: !!appId && status === "active",
  });
  if (status === "restoring")
    return {
      status,
      detail:
        "Deplo is putting a backup back in place. The app is down while it is written, and comes back up on its own.",
    };
  return {
    status: displayStatus(status, runtime, neverDeployed),
    detail: detailFor(runtime),
  };
}

// AppStatusDot - the app header's live power indicator.
export function AppStatusDot({ status }: { status: AppStatus }) {
  const { status: shown, detail } = useDisplayStatus(status);
  return <StatusIndicator status={shown} detail={detail} badge={false} />;
}

// AppStatusBadge - the same live status as the dot, as a labelled badge.
export function AppStatusBadge({ status }: { status: AppStatus }) {
  const { status: shown, detail } = useDisplayStatus(status);
  return <StatusIndicator status={shown} detail={detail} badge />;
}
