import "server-only";

import type { AgentClient, HelloResponse } from "../../agent/gen/agent";
import { AgentUnreachableError } from "../agent-client/errors";
import { LINK_CLOSE, LINK_SETTLE_MS } from "./protocol";

/** A verified agent link. Shared across module instances, so it holds no class a caller tests with instanceof. */
export interface AgentLink {
  readonly id: number;
  readonly serverId: string;
  /** The fingerprint the inner handshake verified. */
  readonly pinnedFingerprint: string;
  /** The link's one HTTP/2 connection; never redialed, it ends with the link. */
  readonly client: AgentClient;
  readonly hello: HelloResponse;
  readonly openedAt: number;
  /** Ends the link now: calls still on it fail as unreachable. */
  close(code: number, reason: string): void;
}

export type AgentLinkEvent =
  | { type: "up"; serverId: string; hello: HelloResponse }
  | { type: "down"; serverId: string; reason: string };

interface Registry {
  links: Map<string, AgentLink>;
  /** Servers that linked since the door opened: a missing link is waited for. */
  seen: Set<string>;
  /** Bumped by every revocation, so a link verified across one is refused. */
  generations: Map<string, number>;
  waiters: Map<string, Set<(link: AgentLink | null) => void>>;
  listeners: Set<(e: AgentLinkEvent) => void>;
  doorOpenedAt: number | null;
  nextId: number;
}

// In memory: the control plane is one process (ADR-0006), and the door and its callers share it.
const KEY = Symbol.for("deplo.agent-link.registry");
const g = globalThis as unknown as { [KEY]?: Registry };
const registry: Registry = (g[KEY] ??= {
  links: new Map(),
  seen: new Set(),
  generations: new Map(),
  waiters: new Map(),
  listeners: new Set(),
  doorOpenedAt: null,
  nextId: 1,
});

export function currentLink(serverId: string): AgentLink | undefined {
  return registry.links.get(serverId);
}

export function hasLinked(serverId: string): boolean {
  return registry.seen.has(serverId);
}

/** The door opened moments ago: a server that has not linked yet may be on its way back. */
export function linksSettling(): boolean {
  const opened = registry.doorOpenedAt;
  return opened !== null && Date.now() - opened < LINK_SETTLE_MS;
}

/**
 * Whether to wait for the server's link rather than judge it: it linked since the door opened, or a dial
 * to it found nobody while links settle after a restart. A trust failure is an answer, never a wait.
 */
export function linkMayCome(serverId: string, failedDial?: unknown): boolean {
  if (registry.seen.has(serverId)) return true;
  return (
    failedDial instanceof AgentUnreachableError &&
    !failedDial.trust &&
    linksSettling()
  );
}

/** The server's link, waiting up to `ms` for one; null when none came. */
export function waitForLink(
  serverId: string,
  ms: number,
): Promise<AgentLink | null> {
  const now = registry.links.get(serverId);
  if (now) return Promise.resolve(now);
  if (ms <= 0 || registry.doorOpenedAt === null) return Promise.resolve(null);
  return new Promise((resolve) => {
    const waiting = registry.waiters.get(serverId) ?? new Set();
    registry.waiters.set(serverId, waiting);
    const done = (link: AgentLink | null) => {
      clearTimeout(timer);
      waiting.delete(done);
      if (waiting.size === 0) registry.waiters.delete(serverId);
      resolve(link);
    };
    const timer = setTimeout(() => done(null), ms);
    waiting.add(done);
  });
}

/** Link up and down, for server status. Returns the unsubscribe. */
export function onAgentLink(listener: (e: AgentLinkEvent) => void): () => void {
  registry.listeners.add(listener);
  return () => registry.listeners.delete(listener);
}

/** Closes the server's link and refuses one verified before now: removal or a replaced certificate. */
export function revokeAgentLink(serverId: string): void {
  registry.generations.set(serverId, linkGeneration(serverId) + 1);
  registry.links.get(serverId)?.close(LINK_CLOSE.revoked, "trust revoked");
}

export function linkGeneration(serverId: string): number {
  return registry.generations.get(serverId) ?? 0;
}

export function nextLinkId(): number {
  return registry.nextId++;
}

/** A verified link takes the server over, unless a revocation came after `generation` was read. */
export function admitLink(link: AgentLink, generation: number): boolean {
  if (registry.doorOpenedAt === null) return false;
  if (linkGeneration(link.serverId) !== generation) return false;
  const old = registry.links.get(link.serverId);
  registry.links.set(link.serverId, link);
  registry.seen.add(link.serverId);
  emit({ type: "up", serverId: link.serverId, hello: link.hello });
  old?.close(LINK_CLOSE.replaced, "replaced by a newer link");
  for (const done of [...(registry.waiters.get(link.serverId) ?? [])])
    done(link);
  return true;
}

export function linkEnded(link: AgentLink, reason: string): void {
  if (registry.links.get(link.serverId) !== link) return;
  registry.links.delete(link.serverId);
  emit({ type: "down", serverId: link.serverId, reason });
}

export function doorOpened(): void {
  registry.doorOpenedAt = Date.now();
}

/** The door closed: every link ends, and nothing is waited for any more. */
export function doorClosed(): void {
  registry.doorOpenedAt = null;
  for (const link of [...registry.links.values()])
    link.close(LINK_CLOSE.stopping, "panel stopping");
  registry.seen.clear();
  for (const waiting of [...registry.waiters.values()])
    for (const done of [...waiting]) done(null);
}

function emit(e: AgentLinkEvent): void {
  for (const listener of [...registry.listeners]) {
    try {
      listener(e);
    } catch (err) {
      console.error("[deplo] agent link listener failed:", err);
    }
  }
}
