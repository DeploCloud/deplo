import "server-only";

import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import type { WebSocket, WebSocketServer } from "ws";

import {
  recordFirstLink,
  serverPinnedTo,
} from "../../data/servers/agent-handshake";
import { clientAddressKey } from "../../http/client-address";
import { rateLimit } from "../../security";
import { HELLO_TIMEOUT_MS } from "../agent-client/deadlines";
import {
  openChannel,
  withClientCert,
  type AgentChannel,
} from "../agent-client/mtls-channel";
import { bridgeLink } from "./bridge";
import {
  LINK_CERT_HEADER,
  LINK_CLOSE,
  LINK_PATH,
  LINK_RATE_LIMIT,
  LINK_SUBPROTOCOL,
} from "./protocol";
import {
  admitLink,
  linkAdmissible,
  linkEnded,
  linkGeneration,
  nextLinkId,
  type AgentLink,
} from "./registry";

export interface Door {
  wss: WebSocketServer;
  /** Where each link's bridge socket goes: a directory only this process can enter. */
  socketDir: string;
  watchdogMs: number;
}

// The public door decides nothing about trust: it names the claimed server, and the handshake decides (ADR-0040).
export async function knock(
  door: Door,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  socket.on("error", () => {});
  try {
    if (new URL(req.url ?? "/", "http://link").pathname !== LINK_PATH)
      return refuse(socket, 404, "Not Found");
    if (!offeredProtocols(req).includes(LINK_SUBPROTOCOL))
      return refuse(socket, 400, "Bad Request");
    const claim = String(req.headers[LINK_CERT_HEADER] ?? "")
      .trim()
      .toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(claim))
      return refuse(socket, 400, "Bad Request");
    const limited = await rateLimit(
      `agent-link:${clientAddressKey(headersOf(req))}`,
      LINK_RATE_LIMIT,
    );
    if (!limited.ok)
      return refuse(socket, 429, "Too Many Requests", {
        "Retry-After": String(limited.retryAfterSec),
      });
    const server = await serverPinnedTo(claim);
    if (!server) return refuse(socket, 404, "Not Found");
    door.wss.handleUpgrade(req, socket, head, (ws) => {
      void holdLink(door, ws, server.id, claim);
    });
  } catch (e) {
    console.error("[deplo] agent link door failed:", e);
    refuse(socket, 503, "Service Unavailable");
  }
}

async function holdLink(
  door: Door,
  ws: WebSocket,
  serverId: string,
  fingerprint: string,
): Promise<void> {
  const id = nextLinkId();
  const openedAt = Date.now();
  let link: AgentLink | null = null;
  let heard = openedAt;
  const hear = () => void (heard = Date.now());
  ws.on("ping", hear).on("pong", hear).on("message", hear);
  ws.on("error", () => {});
  const watchdog = setInterval(
    () => {
      if (Date.now() - heard > door.watchdogMs) ws.terminate();
    },
    Math.min(5_000, door.watchdogMs / 3),
  );
  watchdog.unref();
  let channel: AgentChannel | null = null;
  ws.once("close", (code) => {
    clearInterval(watchdog);
    channel?.close();
    if (link) linkEnded(link, `link closed (${code})`);
  });

  try {
    const bridge = await bridgeLink(ws, join(door.socketDir, `${id}.sock`));
    const target = await withClientCert({
      address: bridge.address,
      // Every agent certificate carries localhost: the pin, not the name, is the identity.
      serverName: "localhost",
      pinnedFingerprint: fingerprint,
    });
    channel = openChannel(target);
    const hello = await channel.hello(HELLO_TIMEOUT_MS);
    // Read before the second look, so a removal that lands after it still refuses this link.
    const generation = linkGeneration(serverId);
    const still = await serverPinnedTo(fingerprint);
    if (ws.readyState !== ws.OPEN) return;
    if (still?.id !== serverId || !linkAdmissible(serverId, generation))
      return void ws.close(LINK_CLOSE.revoked, "trust revoked");
    // As the door admits it, before anyone hears it come up (ADR-0041).
    await recordFirstLink(serverId);
    if (ws.readyState !== ws.OPEN) return;
    const verified: AgentLink = {
      id,
      serverId,
      pinnedFingerprint: fingerprint,
      client: channel.client,
      hello,
      openedAt,
      close(code, reason) {
        linkEnded(verified, reason);
        ws.close(code, reason);
        bridge.close();
      },
    };
    if (!admitLink(verified, generation))
      return void ws.close(LINK_CLOSE.revoked, "trust revoked");
    link = verified;
  } catch (e) {
    if (ws.readyState !== ws.OPEN) return;
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[deplo] agent link for ${serverId} refused: ${why}`);
    ws.close(LINK_CLOSE.refused, "handshake refused");
  } finally {
    // The WebSocket may have closed while this was still verifying it.
    if (!link && ws.readyState === ws.CLOSED) channel?.close();
  }
}

function offeredProtocols(req: IncomingMessage): string[] {
  return String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((p) => p.trim());
}

function headersOf(req: IncomingMessage): Headers {
  const h = new Headers();
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    try {
      h.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
    } catch {}
  }
  return h;
}

function refuse(
  socket: Duplex,
  status: number,
  text: string,
  extra: Record<string, string> = {},
): void {
  if (socket.destroyed) return;
  const lines = Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`);
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n${lines.join("")}\r\n`,
  );
}
