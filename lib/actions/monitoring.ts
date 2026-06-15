"use server";

import { run, type ActionResult } from "./result";
import { getServerMetrics, type ServerMetrics } from "@/lib/data/monitoring";

/** Return a fresh live snapshot for one server. Polled on an interval. */
export async function serverMetricsAction(
  serverId: string,
): Promise<ActionResult<ServerMetrics>> {
  return run(() => getServerMetrics(serverId));
}
