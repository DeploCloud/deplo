"use client";

import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { useLiveStatus } from "@/components/apps/app-live-status";
import type { AppStatus } from "@/lib/types";

/**
 * The project header's power indicator. A client wrapper around StatusDot that
 * reads the live subscription status (green running / yellow building+stopping /
 * grey stopped / red error) so its colour flips in real time, falling back to the
 * server-rendered status until the first subscription snapshot arrives.
 */
export function AppStatusDot({ status }: { status: AppStatus }) {
  return <StatusDot status={useLiveStatus(status)} />;
}

/**
 * The same live app status as {@link AppStatusDot}, but as a LABELLED
 * badge ("Online" / "Stopped" / "Building" / "Error") for the app header —
 * so the container's lifecycle reads clearly and in real time, kept separate
 * from the deployment/commit status shown elsewhere on the page. Rendered as a
 * tinted chip: a running app reads "Online" on a translucent green fill.
 */
export function AppStatusBadge({ status }: { status: AppStatus }) {
  return (
    <StatusBadge status={useLiveStatus(status)} tinted labels={{ active: "Online" }} />
  );
}
