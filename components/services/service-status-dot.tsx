"use client";

import { StatusDot } from "@/components/shared/status-badge";
import { useLiveStatus } from "@/components/services/service-live-status";
import type { ServiceStatus } from "@/lib/types";

/**
 * The project header's power indicator. A client wrapper around StatusDot that
 * reads the live subscription status (green running / yellow deploying+stopping
 * / red stopped|error) so its colour flips in real time, falling back to the
 * server-rendered status until the first subscription snapshot arrives.
 */
export function ServiceStatusDot({ status }: { status: ServiceStatus }) {
  return <StatusDot status={useLiveStatus(status)} />;
}
