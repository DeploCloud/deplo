import "server-only";

import { Metadata } from "@grpc/grpc-js";
import type { AgentConnection } from "./connection";
import {
  SELF_UNINSTALL_TIMEOUT_MS,
  SELF_UPDATE_TIMEOUT_MS,
  STACK_DEADLINE_MS,
} from "./deadlines";
import { toAgentError } from "./errors";
import type { AgentChannel } from "./mtls-channel";

// agentSelfRpc - the calls where the agent acts on ITSELF: its cert, its binary.
export function agentSelfRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  "renewalCsr" | "installRenewedCert" | "selfUpdate" | "selfUninstall"
> {
  const { client } = channel;
  return {
    renewalCsr() {
      return new Promise<{ csrPem: string }>((resolve, reject) => {
        client.renewalCsr(
          {},
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve({ csrPem: resp.csrPem }),
        );
      });
    },
    installRenewedCert(req: { certPem: string; caPem: string }) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.installRenewedCert(
          { certPem: req.certPem, caPem: req.caPem },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    selfUpdate(
      version: string,
      binaries: Record<string, { url: string; sha256: string }>,
    ) {
      return new Promise<{ version: string; restarting: boolean }>(
        (resolve, reject) => {
          client.selfUpdate(
            { version, binaries },
            new Metadata(),
            { deadline: new Date(Date.now() + SELF_UPDATE_TIMEOUT_MS) },
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({
                    version: resp.version,
                    restarting: resp.restarting,
                  }),
          );
        },
      );
    },
    selfUninstall(deadlineMs?: number) {
      return new Promise<string[]>((resolve, reject) => {
        client.selfUninstall(
          {},
          new Metadata(),
          {
            deadline: new Date(
              Date.now() + (deadlineMs ?? SELF_UNINSTALL_TIMEOUT_MS),
            ),
          },
          (err, resp) =>
            err ? reject(toAgentError(err)) : resolve(resp.removed),
        );
      });
    },
  };
}
