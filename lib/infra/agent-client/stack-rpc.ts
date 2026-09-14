import "server-only";

import { Metadata } from "@grpc/grpc-js";
import type { DeployRequest, ReattachRequest } from "../../agent/gen/agent";
import { streamEvents } from "../stream-events";
import type { AgentConnection } from "./connection";
import { DEPLOY_DEADLINE_MS, STACK_DEADLINE_MS } from "./deadlines";
import { toAgentError } from "./errors";
import type { AgentChannel } from "./mtls-channel";

// stackRpc - deploying a stack and moving it through its lifecycle.
export function stackRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  | "deploy"
  | "reattach"
  | "stopStack"
  | "startStack"
  | "destroyStack"
  | "reroute"
  | "readStack"
> {
  const { client, assertNetworkCapable } = channel;
  return {
    deploy(req: DeployRequest) {
      // Refuse BEFORE the stream, so the failure names the server and the remedy
      // instead of arriving as a compose error halfway through a build.
      return (async function* () {
        await assertNetworkCapable(req.network);
        yield* streamEvents(
          client.deploy(req, {
            deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
          }),
          { normalise: toAgentError },
        );
      })();
    },
    reattach(req: ReattachRequest) {
      return streamEvents(
        client.reattachDeploy(req, {
          deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
        }),
        { normalise: toAgentError },
      );
    },
    stopStack(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        // `removeVolumes` is part of StackRef but meaningless for start/stop -
        // these only toggle the running state, never touch volumes.
        client.stopStack(
          { slug, removeVolumes: false, reclaimVolumes: [] },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    startStack(slug: string) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.startStack(
          { slug, removeVolumes: false, reclaimVolumes: [] },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    destroyStack(
      slug: string,
      removeVolumes = false,
      reclaimVolumes: string[] = [],
    ) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.destroyStack(
          { slug, removeVolumes, reclaimVolumes },
          new Metadata(),
          { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({ ok: resp.ok, error: resp.error }),
        );
      });
    },
    reroute(req: {
      slug: string;
      composeYaml: string;
      env: Record<string, string>;
      mounts: { path: string; content: string }[];
      network: string;
      composeUpArgs?: string[];
    }) {
      return assertNetworkCapable(req.network).then(
        () =>
          new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
            client.reroute(
              {
                slug: req.slug,
                composeYaml: req.composeYaml,
                env: req.env,
                mounts: req.mounts,
                network: req.network,
                composeUpArgs: req.composeUpArgs ?? [],
              },
              new Metadata(),
              { deadline: new Date(Date.now() + STACK_DEADLINE_MS) },
              (err, resp) =>
                err
                  ? reject(toAgentError(err))
                  : resolve({ ok: resp.ok, error: resp.error }),
            );
          }),
      );
    },
    readStack(slug: string) {
      return new Promise<{ exists: boolean; yaml: string }>(
        (resolve, reject) => {
          client.readStack(
            { slug, removeVolumes: false, reclaimVolumes: [] },
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({ exists: resp.exists, yaml: resp.yaml }),
          );
        },
      );
    },
  };
}
