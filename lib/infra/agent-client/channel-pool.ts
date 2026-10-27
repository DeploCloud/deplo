import "server-only";

import { connectivityState } from "@grpc/grpc-js";

import type { HelloResponse } from "../../agent/gen/agent";
import { LINK_WAIT_MS } from "../agent-link/protocol";
import {
  currentLink,
  linkMayCome,
  revokeAgentLink,
  waitForLink,
  type AgentLink,
} from "../agent-link/registry";
import { AgentOfflineError, AgentUnreachableError } from "./errors";
import {
  callerView,
  linkChannel,
  openChannel,
  withClientCert,
  type AgentAddress,
  type AgentChannel,
} from "./mtls-channel";

// Far inside the client certificate's 365 days, which every reconnect presents again.
const MAX_AGE_MS = 24 * 3_600_000;

interface PooledChannel {
  key: string;
  openedAt: number;
  /** An agent link's channel: the link owns it, and it ends with the link. */
  linked: boolean;
  ready: Promise<AgentChannel>;
  channel?: AgentChannel;
  /** A Hello has come back on it: a failure now may be a dead connection, not a dead agent. */
  answered: boolean;
  holders: number;
  retired: boolean;
}

// One channel per server, shared by every caller. In memory: one control-plane process (ADR-0006).
const pool = new Map<string, PooledChannel>();

export async function leaseChannel(
  serverId: string,
  address: AgentAddress,
): Promise<{
  channel: AgentChannel;
  answeredBefore: boolean;
  linked: boolean;
}> {
  const link = await linkFor(serverId, address);
  const key = link
    ? `link#${link.id}`
    : `${address.address}|${address.serverName}|${address.pinnedFingerprint}`;
  let shared = pool.get(serverId);
  if (shared && (shared.key !== key || stale(shared) || broken(shared))) {
    retire(serverId, shared);
    shared = undefined;
  }
  if (!shared) {
    const opened = link
      ? Promise.resolve(linkChannel(link.client))
      : withClientCert(address).then((target) => openChannel(target));
    const fresh: PooledChannel = {
      key,
      openedAt: Date.now(),
      linked: !!link,
      ready: opened.then(
        (channel) => (fresh.channel = watchingHello(serverId, fresh, channel)),
      ),
      // The door took the link only after a Hello came back on it.
      answered: !!link,
      holders: 0,
      retired: false,
    };
    pool.set(serverId, (shared = fresh));
  }
  const held = shared;
  const answeredBefore = held.answered;
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
  return { channel: view, answeredBefore, linked: held.linked };
}

/** No new call gets this server's channel, which closes once its last caller lets go; its link closes now. */
export function dropAgentChannel(serverId: string): void {
  const shared = pool.get(serverId);
  if (shared) retire(serverId, shared);
  revokeAgentLink(serverId);
}

// A server that ever linked is reached over its link alone: a missing one is waited for, then it is offline.
async function linkFor(
  serverId: string,
  address: AgentAddress,
): Promise<AgentLink | null> {
  let link = currentLink(serverId);
  if (link && link.pinnedFingerprint !== address.pinnedFingerprint) {
    // Verified against a certificate Deplo no longer pins.
    revokeAgentLink(serverId);
    link = undefined;
  }
  if (link) return link;
  if (!address.linkedOnce && !linkMayCome(serverId)) return null;
  link = (await waitForLink(serverId, LINK_WAIT_MS)) ?? undefined;
  if (link?.pinnedFingerprint === address.pinnedFingerprint) return link;
  throw new AgentOfflineError(serverId);
}

type HelloListener = (serverId: string, hello: HelloResponse) => void;
// On globalThis like the link registry: one set per process, whichever bundle subscribed.
const HELLO_KEY = Symbol.for("deplo.agent-client.hello-listeners");
const slot = globalThis as unknown as { [HELLO_KEY]?: Set<HelloListener> };
const helloListeners: Set<HelloListener> = (slot[HELLO_KEY] ??= new Set());

/** Every Hello an agent answers, direct or over its link: each call to a server starts with one. */
export function onAgentHello(listener: HelloListener): () => void {
  helloListeners.add(listener);
  return () => helloListeners.delete(listener);
}

// Hello is the liveness call: one that cannot get through retires the channel, so the next call dials afresh.
function watchingHello(
  serverId: string,
  shared: PooledChannel,
  channel: AgentChannel,
): AgentChannel {
  return {
    ...channel,
    async hello(timeoutMs) {
      try {
        const answer = await channel.hello(timeoutMs);
        shared.answered = true;
        for (const listener of [...helloListeners]) {
          try {
            listener(serverId, answer);
          } catch (err) {
            console.error("[deplo] agent Hello listener failed:", err);
          }
        }
        return answer;
      } catch (e) {
        if (e instanceof AgentUnreachableError) retire(serverId, shared);
        throw e;
      }
    },
  };
}

function stale(shared: PooledChannel): boolean {
  return !shared.linked && Date.now() - shared.openedAt > MAX_AGE_MS;
}

// A failed connect leaves grpc-js backing off for up to two minutes; a fresh channel dials at once, as before.
function broken(shared: PooledChannel): boolean {
  const state = shared.channel?.client.getChannel().getConnectivityState(false);
  return (
    state === connectivityState.TRANSIENT_FAILURE ||
    state === connectivityState.SHUTDOWN
  );
}

function retire(serverId: string, shared: PooledChannel): void {
  if (pool.get(serverId) === shared) pool.delete(serverId);
  shared.retired = true;
  if (shared.holders === 0) closeShared(shared);
}

function release(shared: PooledChannel): void {
  shared.holders--;
  if (shared.retired && shared.holders === 0) closeShared(shared);
}

function closeShared(shared: PooledChannel): void {
  shared.ready.then(
    (channel) => channel.close(),
    () => {},
  );
}
