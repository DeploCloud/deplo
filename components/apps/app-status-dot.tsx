"use client";

import {
  useLiveApp,
  useLiveStatus,
  useNeverDeployed,
} from "@/components/apps/app-live-status";
import { useAppRuntime } from "@/components/apps/use-app-runtime";
import { displayStatus, type DisplayStatus } from "@/lib/apps/display-status";
import type { AppStatus } from "@/lib/types";
import { detailFor, StatusIndicator } from "./app-status-dot/status-renderer";

/**
 * The one place the app header decides what the app's state IS.
 */
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
  // A restore is the one transient state whose explanation does not come from the
  // host: the containers really are gone, on purpose, and the runtime poll is
  // switched off for exactly that reason. Say what is happening instead.
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

/**
 * The project header's power indicator. Green running / amber building, stopping
 * or restarting / grey stopped / red failed or not-running - flipping in real
 * time, and never green for a container that is not there.
 */
export function AppStatusDot({ status }: { status: AppStatus }) {
  const { status: shown, detail } = useDisplayStatus(status);
  return <StatusIndicator status={shown} detail={detail} badge={false} />;
}

/**
 * The same live app status as {@link AppStatusDot}, but as a LABELLED badge
 * ("Online" / "Restarting" / "Not running" / "Stopped" / "Not deployed" /
 * "Building" / "Error") for the app header, so the container's
 */
export function AppStatusBadge({ status }: { status: AppStatus }) {
  const { status: shown, detail } = useDisplayStatus(status);
  return <StatusIndicator status={shown} detail={detail} badge />;
}
