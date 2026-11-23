import "server-only";

import { connectivityState } from "@grpc/grpc-js";

import type { HelloResponse } from "../../agent/gen/agent";
import { LINK_WAIT_MS } from "../agent-link/protocol";
import {
  currentLink,
  lastHeardAt,
  revokeAgentLink,
  waitForLink,
  type AgentLink,
} from "../agent-link/registry";
import { AgentOfflineError, AgentUnreachableError } from "./errors";
import { callerView, linkChannel, type AgentChannel } from "./mtls-channel";

interface PooledChannel {
  linkId: number;
  channel: AgentChannel;
}

// One channel per server, its agent link's, shared by every caller. In memory: one control-plane process (ADR-0006).
const pool = new Map<string, PooledChannel>();

/** The server's channel over its agent link; a missing link is waited for, then the server is offline (ADR-0040). */
export async function serverChannel(
  serverId: string,
  pinnedFingerprint: string,
): Promise<AgentChannel> {
  const link = await linkFor(serverId, pinnedFingerprint);
  let shared = pool.get(serverId);
  if (shared && (shared.linkId !== link.id || broken(shared.channel)))
    shared = undefined;
  if (!shared) {
    const fresh: PooledChannel = {
      linkId: link.id,
      channel: linkChannel(link.client),
    };
    fresh.channel = watchingHello(serverId, fresh, fresh.channel);
    pool.set(serverId, (shared = fresh));
  }
  return callerView(shared.channel);
}

// Servers a cluster's leader said are not answering: a call waits only briefly for their link (deplo#244).
const DOWN_KEY = Symbol.for("deplo.agent-client.declared-down");
const downSlot = globalThis as unknown as { [DOWN_KEY]?: Set<string> };
const declaredDown: Set<string> = (downSlot[DOWN_KEY] ??= new Set());

/** How long a call waits for the link of a server the leader declared down. */
export const DOWN_LINK_WAIT_MS = 1_000;

/** The leader said this server stopped answering (or answers again); its link coming up clears it too. */
export function declareServerDown(serverId: string, down: boolean): void {
  if (down) declaredDown.add(serverId);
  else declaredDown.delete(serverId);
}

export function serverDeclaredDown(serverId: string): boolean {
  return declaredDown.has(serverId);
}

/** No new call gets this server's channel, and its link closes now. */
export function dropAgentChannel(serverId: string): void {
  pool.delete(serverId);
  revokeAgentLink(serverId);
}

async function linkFor(
  serverId: string,
  pinnedFingerprint: string,
): Promise<AgentLink> {
  let link = currentLink(serverId);
  if (link && link.pinnedFingerprint !== pinnedFingerprint) {
    // Verified against a certificate Deplo no longer pins.
    revokeAgentLink(serverId);
    link = undefined;
  }
  if (link) {
    declaredDown.delete(serverId);
    return link;
  }
  // Silent for longer than the wait itself, its link is not about to come back: every call waited it out in turn.
  const heard = lastHeardAt(serverId);
  const gone = heard !== null && Date.now() - heard > LINK_WAIT_MS;
  const wait =
    declaredDown.has(serverId) || gone ? DOWN_LINK_WAIT_MS : LINK_WAIT_MS;
  link = (await waitForLink(serverId, wait)) ?? undefined;
  if (link?.pinnedFingerprint === pinnedFingerprint) return link;
  throw new AgentOfflineError(serverId);
}

type HelloListener = (serverId: string, hello: HelloResponse) => void;
// On globalThis like the link registry: one set per process, whichever bundle subscribed.
const HELLO_KEY = Symbol.for("deplo.agent-client.hello-listeners");
const slot = globalThis as unknown as { [HELLO_KEY]?: Set<HelloListener> };
const helloListeners: Set<HelloListener> = (slot[HELLO_KEY] ??= new Set());

/** Every Hello an agent answers over its link: each call to a server starts with one. */
export function onAgentHello(listener: HelloListener): () => void {
  helloListeners.add(listener);
  return () => helloListeners.delete(listener);
}

// Hello is the liveness call: one that cannot get through retires the channel, so the next call waits for the link.
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
        for (const listener of [...helloListeners]) {
          try {
            listener(serverId, answer);
          } catch (err) {
            console.error("[deplo] agent Hello listener failed:", err);
          }
        }
        return answer;
      } catch (e) {
        if (e instanceof AgentUnreachableError && pool.get(serverId) === shared)
          pool.delete(serverId);
        throw e;
      }
    },
  };
}

// A link whose connection failed is on its way out of the registry; never hand it to a new call.
function broken(channel: AgentChannel): boolean {
  const state = channel.client.getChannel().getConnectivityState(false);
  return (
    state === connectivityState.TRANSIENT_FAILURE ||
    state === connectivityState.SHUTDOWN
  );
}
