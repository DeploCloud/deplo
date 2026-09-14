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

// One host-ops call: resolve the pinned target, pre-flight the capability via
// Hello, invoke, and always close the channel.
async function withHostOps<T>(
  serverId: string,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  // Through connectAgent, not dial: same target, and the one seam a test can
  // stand in on - host ops had none.
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

/** What this host IS: CPU model, distro, kernel, clock, Docker root dir, plus the
 *  deplo-traefik stack file and whether `controlPlaneHint` names a live container. */
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

/** Move the host clock to an IANA zone, answering with a fresh reading of it. */
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

// Serialise stack rewrites for ONE host: interleaved, the second read misses the
// first write and puts it back - a certificate that reports itself installed and
// is not on the host.
const stackWrites = new Map<string, Promise<unknown>>();

export function withTraefikStackLock<T>(
  serverId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const queued = (stackWrites.get(serverId) ?? Promise.resolve()).then(fn, fn);
  // Swallowed on the CHAIN only: the next writer must run whether or not this one
  // failed, while the caller still sees its own rejection.
  stackWrites.set(
    serverId,
    queued.catch(() => {}),
  );
  return queued;
}

/** Restart the host's Traefik, or rewrite its stack and recreate it. */
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

// restartControlPlaneOn bounces the panel's own container. `ok:true` means
// SCHEDULED: the restart kills the process waiting on the reply.
export function restartControlPlaneOn(
  serverId: string,
  controlPlaneHint: string,
): Promise<RestartControlPlaneResponse> {
  return withHostOps(serverId, (conn) =>
    conn.restartControlPlane({ controlPlaneHint }),
  );
}

// updateControlPlaneOn has the host's agent re-run the Deplo installer. `ok:true`
// means STARTED: the updater outlives the reply and takes this process down with
// it, so the outcome is read from the version that comes back.
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
