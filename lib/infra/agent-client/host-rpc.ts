import "server-only";

import { Metadata } from "@grpc/grpc-js";
import type {
  DockerCleanupRequest,
  DockerCleanupResponse,
  HostInfoRequest,
  HostInfoResponse,
  RestartControlPlaneRequest,
  RestartControlPlaneResponse,
  SetTimezoneRequest,
  TraefikConfigRequest,
  TraefikConfigResponse,
  UpdateControlPlaneRequest,
  UpdateControlPlaneResponse,
} from "../../agent/gen/agent";
import type {
  AgentConnection,
  AgentProbeHttpRequest,
  AgentProbeHttpResult,
} from "./connection";
import {
  CHECK_PORT_DEADLINE_MS,
  CLEANUP_DEADLINE_MS,
  CONTROL_PLANE_UPDATE_DEADLINE_MS,
  HOSTOPS_DEADLINE_MS,
  PROBE_HTTP_DEADLINE_MS,
  TRAEFIK_DEADLINE_MS,
} from "./deadlines";
import { toAgentError } from "./errors";
import { unary, type AgentChannel } from "./mtls-channel";

export function hostRpc(
  channel: AgentChannel,
): Pick<
  AgentConnection,
  | "checkPort"
  | "probeHttp"
  | "dockerCleanup"
  | "hostInfo"
  | "setTimezone"
  | "traefikConfig"
  | "restartControlPlane"
  | "updateControlPlane"
> {
  const { client } = channel;
  return {
    checkPort(port: number) {
      return new Promise<{ available: boolean; reason: string }>(
        (resolve, reject) => {
          client.checkPort(
            { port },
            new Metadata(),
            { deadline: new Date(Date.now() + CHECK_PORT_DEADLINE_MS) },
            (err, resp) =>
              err
                ? reject(toAgentError(err))
                : resolve({ available: resp.available, reason: resp.reason }),
          );
        },
      );
    },
    probeHttp(req: AgentProbeHttpRequest) {
      return new Promise<AgentProbeHttpResult>((resolve, reject) => {
        client.probeHttp(
          {
            projectId: req.appId,
            slug: req.slug,
            service: req.service,
            port: req.port,
            path: req.path,
            host: req.host,
            maxBytes: req.maxBytes,
          },
          new Metadata(),
          { deadline: new Date(Date.now() + PROBE_HTTP_DEADLINE_MS) },
          (err, resp) =>
            err
              ? reject(toAgentError(err))
              : resolve({
                  status: resp.status,
                  contentType: resp.contentType,
                  body: Buffer.from(resp.body),
                  truncated: resp.truncated,
                  location: resp.location,
                }),
        );
      });
    },
    dockerCleanup(req: DockerCleanupRequest) {
      return new Promise<DockerCleanupResponse>((resolve, reject) => {
        client.dockerCleanup(
          req,
          new Metadata(),
          { deadline: new Date(Date.now() + CLEANUP_DEADLINE_MS) },
          (err, resp) => (err ? reject(toAgentError(err)) : resolve(resp)),
        );
      });
    },
    hostInfo(req: HostInfoRequest) {
      return unary<HostInfoRequest, HostInfoResponse>(
        (r, md, opts, cb) => client.hostInfo(r, md, opts, cb),
        req,
        HOSTOPS_DEADLINE_MS,
      );
    },
    setTimezone(req: SetTimezoneRequest) {
      return unary<SetTimezoneRequest, HostInfoResponse>(
        (r, md, opts, cb) => client.setTimezone(r, md, opts, cb),
        req,
        HOSTOPS_DEADLINE_MS,
      );
    },
    traefikConfig(req: TraefikConfigRequest) {
      return unary<TraefikConfigRequest, TraefikConfigResponse>(
        (r, md, opts, cb) => client.traefikConfig(r, md, opts, cb),
        req,
        TRAEFIK_DEADLINE_MS,
      );
    },
    restartControlPlane(req: RestartControlPlaneRequest) {
      return unary<RestartControlPlaneRequest, RestartControlPlaneResponse>(
        (r, md, opts, cb) => client.restartControlPlane(r, md, opts, cb),
        req,
        HOSTOPS_DEADLINE_MS,
      );
    },
    updateControlPlane(req: UpdateControlPlaneRequest) {
      return unary<UpdateControlPlaneRequest, UpdateControlPlaneResponse>(
        (r, md, opts, cb) => client.updateControlPlane(r, md, opts, cb),
        req,
        CONTROL_PLANE_UPDATE_DEADLINE_MS,
      );
    },
  };
}
