import "server-only";

import { Metadata } from "@grpc/grpc-js";
import type {
  DeployRequest,
  DeployUpload,
  ReattachRequest,
} from "../../agent/gen/agent";
import { pumpClientStream, streamEvents } from "../stream-events";
import type { AgentConnection } from "./connection";
import { DEPLOY_DEADLINE_MS, STACK_DEADLINE_MS } from "./deadlines";
import { toAgentError } from "./errors";
import type { AgentChannel } from "./mtls-channel";

export function stackRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  | "deploy"
  | "deployStream"
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
    deployStream(req: DeployRequest, context: AsyncIterable<Buffer>) {
      return (async function* () {
        await assertNetworkCapable(req.network);
        const call = client.deployStream({
          deadline: new Date(Date.now() + DEPLOY_DEADLINE_MS),
        });
        let uploadError: unknown = null;
        const tracked = (async function* () {
          try {
            yield* context;
          } catch (e) {
            uploadError = e;
            throw e;
          }
        })();
        pumpClientStream<DeployUpload>(
          call,
          { request: { ...req, contextTar: new Uint8Array(0) } },
          tracked,
          (contextChunk) => ({ contextChunk }),
          () => {},
        );
        try {
          yield* streamEvents(call, { normalise: toAgentError });
        } catch (e) {
          // A failed upload cancels the call; name the upload, not "Cancelled".
          throw uploadError ? toAgentError(uploadError) : e;
        }
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
    stopStack(slug: string, services: string[] = []) {
      return new Promise<{ ok: boolean; error: string }>((resolve, reject) => {
        client.stopStack(
          { slug, removeVolumes: false, reclaimVolumes: [], services },
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
          { slug, removeVolumes: false, reclaimVolumes: [], services: [] },
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
          { slug, removeVolumes, reclaimVolumes, services: [] },
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
            { slug, removeVolumes: false, reclaimVolumes: [], services: [] },
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
