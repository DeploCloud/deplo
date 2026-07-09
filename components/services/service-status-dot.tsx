"use client";

import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { useLiveStatus } from "@/components/services/service-live-status";
import type { ServiceStatus } from "@/lib/types";

/**
 * The project header's power indicator. A client wrapper around StatusDot that
 * reads the live subscription status (green running / yellow building+stopping /
 * grey stopped / red error) so its colour flips in real time, falling back to the
 * server-rendered status until the first subscription snapshot arrives.
 */
export function ServiceStatusDot({ status }: { status: ServiceStatus }) {
  return <StatusDot status={useLiveStatus(status)} />;
}

/**
 * The same live service status as {@link ServiceStatusDot}, but as a LABELLED
 * badge ("Running" / "Stopped" / "Building" / "Error") for the service header —
 * so the container's lifecycle reads clearly and in real time, kept separate
 * from the deployment/commit status shown elsewhere on the page.
 */
export function ServiceStatusBadge({ status }: { status: ServiceStatus }) {
  return <StatusBadge status={useLiveStatus(status)} />;
}
