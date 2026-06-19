"use server";

import { run, type ActionResult } from "./result";
import {
  getServerMetrics,
  getAllServerMetrics,
  type ServerMetrics,
} from "@/lib/data/monitoring";

/** Return a fresh live snapshot for one server. Polled on an interval. */
export async function serverMetricsAction(
  serverId: string,
): Promise<ActionResult<ServerMetrics>> {
  return run(() => getServerMetrics(serverId));
}

/** Fresh live snapshots for every server. Polled by the servers tab. */
export async function allServerMetricsAction(): Promise<
  ActionResult<ServerMetrics[]>
> {
  return run(() => getAllServerMetrics());
}
