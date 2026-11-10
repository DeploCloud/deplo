import "server-only";

import { status as GrpcStatus, type ServiceError } from "@grpc/grpc-js";
import {
  CLUSTER_MIN_VERSION,
  CLUSTER_VERSION,
  clusterPinned,
  isNewer,
  versionAtLeast,
} from "../../version";
import { connectAgent } from "./connect";
import type { AgentConnection, ClusterHostStatus } from "./connection";
import {
  AgentClusterUnsupportedError,
  CLUSTER_HOST_UNSUPPORTED_MESSAGE,
  ClusterLeaderTooOldError,
  ClusterReleaseUnavailableError,
} from "./errors";
import { CLUSTER_HOST_CAPABILITY } from "./hello-capabilities";

// Every leader call goes through connectAgent(serverId): the agent that supervises the leader is the only door (ADR-0043).
let pinOverride: { version: string; min: string } | null = null;

/** Stands in for package.json's `deplo.cluster` / `deplo.clusterMin`, unset until the first release. */
export function __setClusterPinForTest(
  pin: { version: string; min: string } | null,
): void {
  pinOverride = pin;
}

function pin(): { version: string; min: string } {
  return pinOverride ?? { version: CLUSTER_VERSION, min: CLUSTER_MIN_VERSION };
}

async function onHost<T>(
  serverId: string,
  fn: (conn: AgentConnection) => Promise<T>,
): Promise<T> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CLUSTER_HOST_CAPABILITY))
      throw new AgentClusterUnsupportedError(CLUSTER_HOST_UNSUPPORTED_MESSAGE);
    return await fn(conn);
  } catch (e) {
    if (
      !(e instanceof AgentClusterUnsupportedError) &&
      (e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED
    )
      throw new AgentClusterUnsupportedError(CLUSTER_HOST_UNSUPPORTED_MESSAGE);
    throw e;
  } finally {
    conn.close();
  }
}

/** Installs the pinned cluster binary on the server and runs it as the leader (and the relay, when asked); forward-only. */
export async function installClusterLeader(
  serverId: string,
  opts: { relay?: boolean } = {},
): Promise<{ version: string; running: boolean }> {
  const { version } = pin();
  if (!clusterPinned(version))
    throw new ClusterReleaseUnavailableError(
      "This Deplo has no cluster release to install yet.",
    );
  const { resolveClusterRelease } = await import("../../agent/release");
  const release = await resolveClusterRelease(version);
  if (!release)
    throw new ClusterReleaseUnavailableError(
      "Could not download the cluster release this Deplo installs from GitHub. Try again in a minute.",
    );
  const binaries: Record<string, { url: string; sha256: string }> = {};
  for (const [arch, bin] of Object.entries(release.binaries))
    if (bin) binaries[arch] = { url: bin.url, sha256: bin.sha256 };
  return onHost(serverId, async (conn) => {
    const here = await conn.clusterStatus();
    if (here.installed && isNewer(here.version, release.version))
      throw new Error(
        `This server already runs cluster leader v${here.version}, newer than the v${release.version} this Deplo installs. Nothing to install.`,
      );
    return conn.installCluster(release.version, binaries, opts.relay ?? false);
  });
}

/** Stops the leader (and relay) on the server and deletes them. Nothing installed is not an error. */
export async function removeClusterLeader(
  serverId: string,
): Promise<{ removed: boolean }> {
  return onHost(serverId, (conn) => conn.removeCluster());
}

/** What the server runs: installed or not, running or not, which version. */
export async function clusterLeaderStatus(
  serverId: string,
): Promise<ClusterHostStatus> {
  return onHost(serverId, (conn) => conn.clusterStatus());
}

/** One call to the leader on `serverId`, forwarded by its agent. A leader below `clusterMin` is refused. */
export async function callClusterLeader(
  serverId: string,
  method: string,
  payload: Uint8Array = new Uint8Array(),
): Promise<Uint8Array> {
  return onHost(serverId, async (conn) => {
    const here = await conn.clusterStatus();
    if (!here.installed || !here.running)
      throw new Error(
        here.installed
          ? "The cluster leader on this server is not running."
          : "No cluster leader is installed on this server.",
      );
    const { min } = pin();
    if (!versionAtLeast(here.version, min))
      throw new ClusterLeaderTooOldError(here.version, min);
    return conn.clusterCall(method, payload);
  });
}
