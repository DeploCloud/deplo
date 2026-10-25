import "server-only";

import type { HelloResponse, LinkAddresses } from "../../agent/gen/agent";
import { isDeploHostServer } from "../../deploy/domains";
import { onAgentHello } from "../../infra/agent-client/channel-pool";
import { connectAgent } from "../../infra/agent-client/connect";
import { AGENT_LINK_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { currentLink, onAgentLink } from "../../infra/agent-link/registry";
import { PUBLIC_URL_PLACEHOLDER } from "../../public-url";
import { withoutRequestCache } from "../../request-cache";
import type { Server } from "../../types/server";
import { instanceFrozen } from "../deplo-move/freeze";
import { panelFallbackUrl } from "../instance-settings/panel-fallback";
import { loadSettings } from "../instance-settings/settings-store";
import { takeoverAwaitsCutover } from "../takeover";
import { agentLinkUrl } from "./panel-address";
import { getServerById, listAllServers } from "./roster";

/** What a change to the panel's address is about to make true, before the settings say so. */
export interface PanelAddressChange {
  url?: string;
  fallbackOff?: boolean;
}

interface Sync {
  off: (() => void) | null;
  /** One reconcile per server at a time: its own Hello must not start another. */
  running: Map<string, Promise<void>>;
  pending: PanelAddressChange | null;
  lastError: Map<string, string>;
}

// On globalThis like the link registry it listens to: one per process.
const KEY = Symbol.for("deplo.link-addresses.sync");
const g = globalThis as unknown as { [KEY]?: Sync };
const sync: Sync = (g[KEY] ??= {
  off: null,
  running: new Map(),
  pending: null,
  lastError: new Map(),
});

/** Keeps linking agents on the panel's pair and closes a linked one's port (ADR-0038). Start it before the door opens. */
export function startLinkAddressSync(): void {
  if (sync.off) return;
  // Queued even behind a running pass: that pass started before this link was verified.
  const offLink = onAgentLink((e) => {
    if (e.type === "up" && keepsPair(e.hello)) void queue(e.serverId, e.hello);
  });
  const offHello = onAgentHello((id, hello) => void agentHelloSeen(id, hello));
  sync.off = () => {
    offLink();
    offHello();
  };
}

/** Stops listening, and settles once every pair already on its way has been sent or given up on. */
export async function stopLinkAddressSync(): Promise<void> {
  sync.off?.();
  sync.off = null;
  await Promise.all([...sync.running.values()]);
}

/** The pair the panel wants this server's agent to keep; null while it cannot say. */
export async function wantedLinkAddresses(
  server: Server,
): Promise<LinkAddresses | null> {
  // No request: the address an agent keeps never depends on who asked.
  const linkUrl = await agentLinkUrl(server, new Headers());
  if (isDeploHostServer(server)) return { primary: linkUrl, fallback: "" };
  const primary = sync.pending?.url ?? linkUrl;
  if (primary === PUBLIC_URL_PLACEHOLDER) return null;
  // Until the cutover only the other platform's proxy reaches the panel, through the side door it enrolled on.
  if (await takeoverAwaitsCutover()) return null;
  const off =
    sync.pending?.fallbackOff ?? (await loadSettings()).panelFallbackDisabled;
  const fallback = off ? null : await panelFallbackUrl(primary);
  return { primary, fallback: fallback === primary ? "" : (fallback ?? "") };
}

/** A Hello the control plane saw: a linking agent is sent the panel's pair, and stops listening once linked. */
export function agentHelloSeen(
  serverId: string,
  hello: HelloResponse,
): Promise<void> {
  if (!keepsPair(hello) || sync.running.has(serverId)) return Promise.resolve();
  return queue(serverId, hello);
}

/**
 * Every linked agent learns the panel's next addresses before `change` rewrites the panel's proxy,
 * which drops every link through it; afterwards each is put in step with what the panel kept.
 */
export async function whilePanelAddressesChange<T>(
  next: PanelAddressChange,
  change: () => Promise<T>,
): Promise<T> {
  const before = sync.pending;
  sync.pending = { ...before, ...next };
  try {
    await sendToLinkedAgents();
    return await change();
  } finally {
    sync.pending = before;
    await sendToLinkedAgents();
  }
}

async function sendToLinkedAgents(): Promise<void> {
  try {
    const linked = (await listAllServers()).filter((s) => currentLink(s.id));
    await Promise.all(linked.map((s) => queue(s.id)));
  } catch (e) {
    console.error("[deplo] could not send agents the panel's addresses:", e);
  }
}

// `seen` unset: ask the agent on the connection that sends.
function queue(serverId: string, seen?: HelloResponse): Promise<void> {
  const run = (sync.running.get(serverId) ?? Promise.resolve())
    .then(() => reconcile(serverId, seen))
    .then(
      () => void sync.lastError.delete(serverId),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        if (sync.lastError.get(serverId) === message) return;
        sync.lastError.set(serverId, message);
        console.error(
          `[deplo] could not send server ${serverId} its panel addresses: ${message}`,
        );
      },
    )
    .finally(() => {
      if (sync.running.get(serverId) === run) sync.running.delete(serverId);
    });
  sync.running.set(serverId, run);
  return run;
}

function reconcile(serverId: string, seen?: HelloResponse): Promise<void> {
  return withoutRequestCache(async () => {
    if (await instanceFrozen()) return;
    const server = await getServerById(serverId);
    if (!server) return;
    const wanted = await wantedLinkAddresses(server);
    if (!wanted) return;
    // Read before connecting: a server seen linked is reached over its link alone, never its port.
    const linked = currentLink(serverId) !== undefined;
    if (seen && settled(seen, wanted, linked)) return;
    const conn = await connectAgent(serverId);
    try {
      const hello = seen ?? (await conn.hello());
      if (!keepsPair(hello) || settled(hello, wanted, linked)) return;
      if (!samePair(hello.linkAddresses, wanted))
        await conn.setLinkAddresses(wanted);
      // It keeps the panel's pair and its link is verified: its own port has no use left.
      if (linked && hello.listening) await conn.stopListening();
    } finally {
      conn.close();
    }
  });
}

function settled(
  hello: HelloResponse,
  wanted: LinkAddresses,
  linked: boolean,
): boolean {
  return (
    !!hello.linkAddresses &&
    samePair(hello.linkAddresses, wanted) &&
    !(linked && hello.listening)
  );
}

function keepsPair(
  hello: HelloResponse,
): hello is HelloResponse & { linkAddresses: LinkAddresses } {
  return (
    !!hello.linkAddresses &&
    hello.capabilities?.includes(AGENT_LINK_CAPABILITY) === true
  );
}

function samePair(a: LinkAddresses, b: LinkAddresses): boolean {
  return a.primary === b.primary && a.fallback === b.fallback;
}
