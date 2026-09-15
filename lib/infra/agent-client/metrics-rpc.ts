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
        { maxQueued: METRICS_STREAM_MAX_QUEUED, normalise: toAgentError },
      );
    },
  };
}
