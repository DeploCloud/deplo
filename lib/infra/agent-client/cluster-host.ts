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
  AgentClusterImagesUnsupportedError,
  AgentClusterMemberUnsupportedError,
  AgentClusterUnsupportedError,
  AgentTooOldError,
  CLUSTER_HOST_UNSUPPORTED_MESSAGE,
  CLUSTER_IMAGES_UNSUPPORTED_MESSAGE,
  CLUSTER_MEMBER_UNSUPPORTED_MESSAGE,
  ClusterLeaderTooOldError,
  ClusterReleaseUnavailableError,
} from "./errors";
import {
  CLUSTER_CAPABILITY,
  CLUSTER_FAILOVER_CAPABILITY,
  CLUSTER_HOST_CAPABILITY,
  CLUSTER_IMAGES_CAPABILITY,
} from "./hello-capabilities";

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

/**
 * The leader's event stream on `serverId` after `since`, one JSON line per item. The connection stays open until
 * the caller stops iterating. A leader below `clusterMin` is refused, as for a call.
 */
export async function* watchClusterLeader(
  serverId: string,
  since: number,
): AsyncGenerator<Uint8Array, void, unknown> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CLUSTER_HOST_CAPABILITY))
      throw new AgentClusterUnsupportedError(CLUSTER_HOST_UNSUPPORTED_MESSAGE);
    const here = await conn.clusterStatus();
    if (!here.installed || !here.running)
      throw new Error("The cluster leader on this server is not running.");
    const { min } = pin();
    if (!versionAtLeast(here.version, min))
      throw new ClusterLeaderTooOldError(here.version, min);
    yield* conn.clusterWatch(since);
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

/** One call to the relay on `serverId`, forwarded by its agent. A method is named `relay.<verb>`. */
export async function callClusterRelay(
  serverId: string,
  method: `relay.${string}`,
  payload: Uint8Array = new Uint8Array(),
): Promise<Uint8Array> {
  return onHost(serverId, async (conn) => {
    const here = await conn.clusterStatus();
    if (!here.installed || !here.running || !here.relay)
      throw new Error("No cluster relay is running on this server.");
    const { min } = pin();
    if (!versionAtLeast(here.version, min))
      throw new ClusterLeaderTooOldError(here.version, min);
    return conn.clusterCall(method, payload);
  });
}

export type MemberProbe = "ok" | "too_old" | "offline";

/** Whether the server's agent answers and can be a cluster member (Hello capability `cluster`). Never throws. */
export async function probeClusterMember(
  serverId: string,
): Promise<MemberProbe> {
  let conn: AgentConnection;
  try {
    conn = await connectAgent(serverId);
  } catch (e) {
    return e instanceof AgentTooOldError ? "too_old" : "offline";
  }
  try {
    const hello = await conn.hello();
    return hello.capabilities?.includes(CLUSTER_CAPABILITY) ? "ok" : "too_old";
  } catch {
    return "offline";
  } finally {
    conn.close();
  }
}

const takesOver = new Map<string, { can: boolean; until: number }>();

/** Test seam: forget what each agent was last seen able to do. */
export function __forgetMemberProbes(): void {
  takesOver.clear();
}

/**
 * Whether the member's agent can start a workload its leader moves to it (Hello `cluster.failover`).
 * An agent that does not answer counts as able: the leader believes only a member that says it started.
 */
export async function memberTakesOver(serverId: string): Promise<boolean> {
  const seen = takesOver.get(serverId);
  if (seen && seen.until > Date.now()) return seen.can;
  let can = true;
  let answered = false;
  try {
    const conn = await connectAgent(serverId);
    try {
      const hello = await conn.hello();
      answered = true;
      can = Boolean(hello.capabilities?.includes(CLUSTER_FAILOVER_CAPABILITY));
    } finally {
      conn.close();
    }
  } catch {
    // unknown: asked again in a minute
  }
  // An agent never loses a capability, so a yes is kept; a no or no answer is asked again.
  takesOver.set(serverId, {
    can,
    until: answered && can ? Infinity : Date.now() + 60_000,
  });
  return can;
}

/** Makes the server's agent a cluster party that dials every relay it knows, or stops it (ADR-0044). */
export async function setClusterMember(
  serverId: string,
  member: boolean,
  relays: string[] = [],
): Promise<{ member: boolean; relayLinks: number }> {
  const conn = await connectAgent(serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CLUSTER_CAPABILITY))
      throw new AgentClusterMemberUnsupportedError(
        CLUSTER_MEMBER_UNSUPPORTED_MESSAGE,
      );
    return await conn.setClusterMember(member, relays);
  } catch (e) {
    if (
      !(e instanceof AgentClusterMemberUnsupportedError) &&
      (e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED
    )
      throw new AgentClusterMemberUnsupportedError(
        CLUSTER_MEMBER_UNSUPPORTED_MESSAGE,
      );
    throw e;
  } finally {
    conn.close();
  }
}

export type ImageCopyResult = {
  alreadyPresent: boolean;
  bytes: number;
  /** Older releases the target removed to keep the last ones. */
  pruned: string[];
};

/** Asks the agent of the server holding `imageRef` to send it to the member with that certificate (ADR-0044). */
export async function copyClusterImage(
  sourceServerId: string,
  imageRef: string,
  targetFingerprint: string,
  keep: number,
): Promise<ImageCopyResult> {
  const conn = await connectAgent(sourceServerId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(CLUSTER_IMAGES_CAPABILITY))
      throw new AgentClusterImagesUnsupportedError(
        CLUSTER_IMAGES_UNSUPPORTED_MESSAGE,
      );
    return await conn.copyClusterImage(imageRef, targetFingerprint, keep);
  } catch (e) {
    if (
      !(e instanceof AgentClusterImagesUnsupportedError) &&
      (e as Partial<ServiceError> | null)?.code === GrpcStatus.UNIMPLEMENTED
    )
      throw new AgentClusterImagesUnsupportedError(
        CLUSTER_IMAGES_UNSUPPORTED_MESSAGE,
      );
    throw e;
  } finally {
    conn.close();
  }
}
