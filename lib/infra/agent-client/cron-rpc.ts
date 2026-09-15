import "server-only";

import { Metadata } from "@grpc/grpc-js";
import type {
  AgentConnection,
  AgentJobStatus,
  AgentStartJobRequest,
} from "./connection";
import { CRON_POLL_TIMEOUT_MS, CRON_START_TIMEOUT_MS } from "./deadlines";
import { toAgentError } from "./errors";
import type { AgentChannel } from "./mtls-channel";

export function cronRpc(
  channel: AgentChannel,
): Pick<AgentConnection, "startJob" | "pollJob" | "killJob"> {
  const { client } = channel;
  return {
    startJob(req: AgentStartJobRequest) {
      return new Promise<string>((resolve, reject) => {
        client.startJob(
          req,
          new Metadata(),
          { deadline: new Date(Date.now() + CRON_START_TIMEOUT_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.jobId),
        );
      });
    },
    pollJob(jobId: string) {
      return new Promise<AgentJobStatus>((resolve, reject) => {
        client.pollJob(
          { jobId },
          new Metadata(),
          { deadline: new Date(Date.now() + CRON_POLL_TIMEOUT_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  found: resp.found,
                  running: resp.running,
                  exitCode: resp.exitCode,
                  stdout: resp.stdout,
                  stderr: resp.stderr,
                  timedOut: resp.timedOut,
                }),
        );
      });
    },
    killJob(jobId: string) {
      return new Promise<boolean>((resolve, reject) => {
        client.killJob(
          { jobId },
          new Metadata(),
          { deadline: new Date(Date.now() + CRON_POLL_TIMEOUT_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.found),
        );
      });
    },
  };
}
