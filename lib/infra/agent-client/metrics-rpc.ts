import "server-only";

import { Metadata } from "@grpc/grpc-js";
import type {
  ContainerStat,
  HostMetrics,
  MetricsStreamRequest,
} from "../../agent/gen/agent";
import { streamEvents } from "../stream-events";
import type { AgentConnection } from "./connection";
import {
  METRICS_STREAM_DEADLINE_MS,
  METRICS_STREAM_MAX_QUEUED,
  METRICS_TIMEOUT_MS,
} from "./deadlines";
import { toAgentError } from "./errors";
import type { AgentChannel } from "./mtls-channel";

// metricsRpc - the host and container telemetry arm of a connection.
export function metricsRpc(
  channel: AgentChannel,
): Pick<AgentConnection, "metrics" | "containerStats" | "streamMetrics"> {
  const { client } = channel;
  const metricsDeadline = () => ({
    deadline: new Date(Date.now() + METRICS_TIMEOUT_MS),
  });
  return {
    metrics(dataDir = "") {
      return new Promise<HostMetrics>((resolve, reject) => {
        // A SHORT deadline is mandatory: the dashboard polls ~1s, so an agent that
        // accepts the dial but cannot finish measuring must fail fast rather than
        // amplify a brief pin into a minute-long chart gap.
        client.metrics(
          { dataDir },
          new Metadata(),
          metricsDeadline(),
          (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp)),
        );
      });
    },
    containerStats(projectId: string, containers: string[]) {
      return new Promise<ContainerStat[]>((resolve, reject) => {
        // Same reasoning as metrics(): an agent that accepts the dial but can't finish
        // stat-ing the stack (e.g. its containers are mid-recreate during a deploy) must
        // fail fast and let the next tick recover.
        client.containerStats(
          { projectId, containers },
          new Metadata(),
          metricsDeadline(),
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.stats),
        );
      });
    },
    streamMetrics(req: MetricsStreamRequest) {
      return streamEvents(
        client.streamMetrics(req, {
          deadline: new Date(Date.now() + METRICS_STREAM_DEADLINE_MS),
        }),
        // Bounded, drop-oldest.
        { maxQueued: METRICS_STREAM_MAX_QUEUED, normalise: toAgentError },
      );
    },
  };
}
