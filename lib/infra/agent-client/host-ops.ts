import "server-only";

import { status as GrpcStatus, type ServiceError } from "@grpc/grpc-js";
import type {
  HostInfoResponse,
  RestartControlPlaneResponse,
  TraefikConfigResponse,
  UpdateControlPlaneResponse,
} from "../../agent/gen/agent";
import { connectAgent, dial } from "./connect";
import type { AgentConnection } from "./connection";
import {
  AgentControlPlaneUpdateUnsupportedError,
  AgentHostOpsUnsupportedError,
  CONTROL_PLANE_UPDATE_UNSUPPORTED_MESSAGE,
  HOSTOPS_UNSUPPORTED_MESSAGE,
  mapHostOpsUnsupported,
} from "./errors";
import {
  CONTROL_PLANE_UPDATE_CAPABILITY,
  HOSTOPS_CAPABILITY,
} from "./hello-capabilities";
import { resolveTarget } from "./mtls-channel";

async function withHostOps<T>(
  serverId: string,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(HOSTOPS_CAPABILITY)) {
      throw new AgentHostOpsUnsupportedError(HOSTOPS_UNSUPPORTED_MESSAGE);
    }
    return await fn(conn);
  } catch (e) {
    throw mapHostOpsUnsupported(e);
  } finally {
    conn.close();
  }
}

export function fetchHostInfo(
  serverId: string,
  opts: { dataDir?: string; controlPlaneHint?: string } = {},
): Promise<HostInfoResponse> {
  return withHostOps(serverId, (conn) =>
    conn.hostInfo({
      dataDir: opts.dataDir ?? "",
      controlPlaneHint: opts.controlPlaneHint ?? "",
    }),
  );
}

export function setHostTimezone(
  serverId: string,
  timezone: string,
  opts: { dataDir?: string; controlPlaneHint?: string } = {},
): Promise<HostInfoResponse> {
  return withHostOps(serverId, (conn) =>
    conn.setTimezone({
      timezone,
      dataDir: opts.dataDir ?? "",
      controlPlaneHint: opts.controlPlaneHint ?? "",
    }),
  );
}

// Serialised per host: interleaved rewrites put the old stack back, leaving a cert that reports itself installed.
const stackWrites = new Map<string, Promise<unknown>>();

export function withTraefikStackLock<T>(
  serverId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const queued = (stackWrites.get(serverId) ?? Promise.resolve()).then(fn, fn);
  stackWrites.set(
    serverId,
    queued.catch(() => {}),
  );
  return queued;
}

export function applyTraefikConfig(
  serverId: string,
  req: { composeYaml?: string; restartOnly?: boolean },
): Promise<TraefikConfigResponse> {
  return withHostOps(serverId, (conn) =>
    conn.traefikConfig({
      composeYaml: req.composeYaml ?? "",
      restartOnly: req.restartOnly ?? false,
    }),
  );
}

export function restartControlPlaneOn(
  serverId: string,
  controlPlaneHint: string,
): Promise<RestartControlPlaneResponse> {
  return withHostOps(serverId, (conn) =>
    conn.restartControlPlane({ controlPlaneHint }),
  );
}

export async function updateControlPlaneOn(
  serverId: string,
  controlPlaneHint: string,
  version: string,
): Promise<UpdateControlPlaneResponse> {
  const target = await resolveTarget(serverId);
  const conn = dial(target);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CONTROL_PLANE_UPDATE_CAPABILITY)) {
      throw new AgentControlPlaneUpdateUnsupportedError(
        CONTROL_PLANE_UPDATE_UNSUPPORTED_MESSAGE,
      );
    }
    return await conn.updateControlPlane({ controlPlaneHint, version });
  } catch (e) {
    if (
      !(e instanceof AgentControlPlaneUpdateUnsupportedError) &&
      (e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED
    ) {
      throw new AgentControlPlaneUpdateUnsupportedError(
        CONTROL_PLANE_UPDATE_UNSUPPORTED_MESSAGE,
      );
    }
    throw e;
  } finally {
    conn.close();
  }
}
