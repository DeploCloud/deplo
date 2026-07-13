"use client";

import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useLiveApp, useLiveStatus } from "@/components/apps/app-live-status";
import {
  useAppRuntime,
  type AppRuntimeView,
} from "@/components/apps/use-app-runtime";
import { displayStatus, type DisplayStatus } from "@/lib/apps/display-status";
import type { AppStatus } from "@/lib/types";

/**
 * The one place the app header decides what the app's state IS.
 *
 * Two sources, folded by {@link displayStatus}: the live subscription (what the
 * control plane last DID — deploy / start / stop) and a poll of the owning agent
 * (what the containers are actually DOING). The subscription alone is what used
 * to report a crash-looping app as "Online" — nothing pushes when a container
 * dies of its own accord, so the stored "active" stood unchallenged. The runtime
 * poll runs only while we claim to be up, which is the only claim it can refute.
 */
function useDisplayStatus(fallback: AppStatus): {
  status: DisplayStatus;
  detail: string | null;
} {
  const live = useLiveApp();
  const status = useLiveStatus(fallback);
  const appId = live?.id ?? "";
  const runtime = useAppRuntime(appId, {
    enabled: !!appId && status === "active",
  });
  return { status: displayStatus(status, runtime), detail: detailFor(runtime) };
}

/** The sentence behind a badge that is reporting trouble. */
function detailFor(runtime: AppRuntimeView | null): string | null {
  if (!runtime || runtime.unreachable) return null;

  if (runtime.restarting > 0) {
    // The restart count is what separates "it is booting" from "it has been
    // dying all afternoon", so lead with it when the agent reports one.
    const restarts = Math.max(
      ...runtime.containers.map((c) => c.restartCount),
      0,
    );
    const times = restarts > 0 ? ` It has restarted ${restarts} times.` : "";
    return `Docker keeps restarting this container: it starts, dies, and starts again.${times} The Logs tab shows why.`;
  }
  if (runtime.total === 0)
    return "This app is deployed, but it has no container on its server at all.";
  if (runtime.running === 0)
    return "This app is deployed, but no container is running on the host. The Logs tab shows its last output.";
  if (runtime.missing.length > 0)
    return `The rest of this stack is up, but ${runtime.missing.join(", ")} has no container on the host at all.`;
  if (runtime.running < runtime.total)
    return `Only ${runtime.running} of ${runtime.total} containers in this stack are running.`;
  if (runtime.unhealthy > 0) {
    const sick = runtime.containers
      .filter((c) => c.health === "unhealthy")
      .map((c) => c.service);
    return `Everything is running, but ${sick.join(", ") || "a container"} is failing its healthcheck — up, but not working.`;
  }
  return null;
}

/**
 * The project header's power indicator. Green running / amber building, stopping
 * or restarting / grey stopped / red failed or not-running — flipping in real
 * time, and never green for a container that is not there.
 */
export function AppStatusDot({ status }: { status: AppStatus }) {
  const { status: shown, detail } = useDisplayStatus(status);
  const dot = <StatusDot status={shown} />;
  return detail ? (
    <SimpleTooltip content={detail}>
      <span className="inline-flex">{dot}</span>
    </SimpleTooltip>
  ) : (
    dot
  );
}

/**
 * The same live app status as {@link AppStatusDot}, but as a LABELLED badge
 * ("Online" / "Restarting" / "Degraded" / "Not running" / "Stopped" / "Building"
 * / "Error") for the app header — so the container's lifecycle reads clearly and
 * in real time, kept separate from the deployment/commit status shown elsewhere
 * on the page. Rendered as a tinted chip.
 */
export function AppStatusBadge({ status }: { status: AppStatus }) {
  const { status: shown, detail } = useDisplayStatus(status);
  const badge = (
    <StatusBadge status={shown} tinted labels={{ active: "Online" }} />
  );
  // A tooltip only when the badge is reporting trouble — explaining "Online"
  // would be noise.
  return detail ? (
    <SimpleTooltip content={detail}>
      <span className="inline-flex">{badge}</span>
    </SimpleTooltip>
  ) : (
    badge
  );
}
