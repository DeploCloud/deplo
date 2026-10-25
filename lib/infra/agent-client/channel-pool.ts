import "server-only";

import { connectivityState } from "@grpc/grpc-js";

import { AgentUnreachableError } from "./errors";
import {
  callerView,
  openChannel,
  withClientCert,
  type AgentAddress,
  type AgentChannel,
} from "./mtls-channel";

// Far inside the client certificate's 365 days, which every reconnect presents again.
const MAX_AGE_MS = 24 * 3_600_000;

interface Shared {
  key: string;
  openedAt: number;
  ready: Promise<AgentChannel>;
  channel?: AgentChannel;
  /** A Hello has come back on it: a failure now may be a dead connection, not a dead agent. */
  proven: boolean;
  holders: number;
  retired: boolean;
}

// One channel per server, shared by every caller. In memory: one control-plane process (ADR-0006).
const pool = new Map<string, Shared>();

export async function leaseChannel(
  serverId: string,
  address: AgentAddress,
): Promise<{ channel: AgentChannel; reused: boolean }> {
  const key = `${address.address}|${address.serverName}|${address.pinnedFingerprint}`;
  let shared = pool.get(serverId);
  if (shared && (shared.key !== key || stale(shared) || broken(shared))) {
    retire(serverId, shared);
    shared = undefined;
  }
  if (!shared) {
    const fresh: Shared = {
      key,
      openedAt: Date.now(),
      ready: withClientCert(address)
        .then(openChannel)
        .then((channel) => (fresh.channel = proving(serverId, fresh, channel))),
      proven: false,
      holders: 0,
      retired: false,
    };
    pool.set(serverId, (shared = fresh));
  }
  const held = shared;
  const reused = held.proven;
  held.holders++;
  let channel: AgentChannel;
  try {
    channel = await held.ready;
  } catch (e) {
    retire(serverId, held);
    release(held);
    throw e;
  }
  let closed = false;
  const view = callerView(channel, () => {
    if (closed) return;
    closed = true;
    release(held);
  });
  return { channel: view, reused };
}

/** No new call gets this server's channel; it closes once its last caller lets go. */
export function dropAgentChannel(serverId: string): void {
  const shared = pool.get(serverId);
  if (shared) retire(serverId, shared);
}

// Hello is the liveness call: one that cannot get through retires the channel, so the next call dials afresh.
function proving(
  serverId: string,
  shared: Shared,
  channel: AgentChannel,
): AgentChannel {
  return {
    ...channel,
    async hello(timeoutMs) {
      try {
        const answer = await channel.hello(timeoutMs);
        shared.proven = true;
        return answer;
      } catch (e) {
        if (e instanceof AgentUnreachableError) retire(serverId, shared);
        throw e;
      }
    },
  };
}

function stale(shared: Shared): boolean {
  return Date.now() - shared.openedAt > MAX_AGE_MS;
}

// A failed connect leaves grpc-js backing off for up to two minutes; a fresh channel dials at once, as before.
function broken(shared: Shared): boolean {
  const state = shared.channel?.client.getChannel().getConnectivityState(false);
  return (
    state === connectivityState.TRANSIENT_FAILURE ||
    state === connectivityState.SHUTDOWN
  );
}

function retire(serverId: string, shared: Shared): void {
  if (pool.get(serverId) === shared) pool.delete(serverId);
  shared.retired = true;
  if (shared.holders === 0) closeShared(shared);
}

function release(shared: Shared): void {
  shared.holders--;
  if (shared.retired && shared.holders === 0) closeShared(shared);
}

function closeShared(shared: Shared): void {
  shared.ready.then(
    (channel) => channel.close(),
    () => {},
  );
}
