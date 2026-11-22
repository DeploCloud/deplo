import "server-only";

import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";

import {
  createWebSocketStream,
  type WebSocket,
  type WebSocketServer,
} from "ws";

import { recordFirstLink } from "../../data/servers/agent-handshake";
import {
  claimedIdentity,
  identityCopied,
  promoteNextCert,
  recordLinkOrigin,
  type ClaimedIdentity,
} from "../../data/servers/agent-identity";
import { clientAddressKey, connectionAddress } from "../../http/client-address";
import { rateLimit } from "../../security";
import { HELLO_TIMEOUT_MS } from "../agent-client/deadlines";
import { HOST_ADDRESSES_CAPABILITY } from "../agent-client/hello-capabilities";
import {
  linkChannel,
  openChannel,
  type AgentChannel,
} from "../agent-client/mtls-channel";
import { agentTls, certLapsed, keyFingerprint } from "./agent-tls";
import { bridgeLink } from "./bridge";
import {
  LINK_CERT_HEADER,
  LINK_CLOSE,
  LINK_COPY_PING_MS,
  LINK_PATH,
  LINK_PING_MS,
  LINK_RATE_LIMIT,
  LINK_SUBPROTOCOL,
} from "./protocol";
import {
  admitLink,
  currentLink,
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
    const headers = headersOf(req);
    const limited = await rateLimit(
      `agent-link:${clientAddressKey(headers)}`,
      LINK_RATE_LIMIT,
    );
    if (!limited.ok)
      return refuse(socket, 429, "Too Many Requests", {
        "Retry-After": String(limited.retryAfterSec),
      });
    const claimed = await claimedIdentity(claim);
    if (!claimed) return refuse(socket, 404, "Not Found");
    const from = connectionAddress(req.socket.remoteAddress, headers);
    door.wss.handleUpgrade(req, socket, head, (ws) => {
      void holdLink(door, ws, claimed, claim, from);
    });
  } catch (e) {
    console.error("[deplo] agent link door failed:", e);
    refuse(socket, 503, "Service Unavailable");
  }
}

async function holdLink(
  door: Door,
  ws: WebSocket,
  claimed: ClaimedIdentity,
  fingerprint: string,
  from: string | null,
): Promise<void> {
  const { serverId } = claimed;
  const id = nextLinkId();
  const openedAt = Date.now();
  let link: AgentLink | null = null;
  let heard = openedAt;
  const hear = () => void (heard = Date.now());
  ws.on("ping", hear).on("pong", hear).on("message", hear);
  ws.on("error", () => {});
  // A server that crashed sends no close: the pong it stops answering is how its link ends.
  const watchdog = setInterval(
    () => {
      if (Date.now() - heard > door.watchdogMs) return void ws.terminate();
      if (ws.readyState === ws.OPEN) ws.ping();
    },
    Math.min(LINK_PING_MS, door.watchdogMs / 3),
  );
  watchdog.unref();
  let channel: AgentChannel | null = null;
  ws.once("close", (code) => {
    clearInterval(watchdog);
    channel?.close();
    if (link) linkEnded(link, `link closed (${code})`);
  });

  try {
    const stream = createWebSocketStream(ws);
    stream.on("error", () => {});
    // The agent's key, not its certificate, is who it is: a certificate past its date still proves it (ADR-0050).
    const session = await agentTls(
      stream,
      keyFingerprint(claimed.certPem),
      await panelClientCert(),
      HELLO_TIMEOUT_MS,
      certLapsed(claimed.certPem),
    );
    if (claimed.kind === "retired") {
      // It proved a key this server rotated away from: a copy that missed the rotation.
      identityCopied(claimed, "missed-rotation");
      return void ws.close(LINK_CLOSE.copied, "identity in use");
    }
    const bridge = await bridgeLink(
      session,
      ws,
      join(door.socketDir, `${id}.sock`),
    );
    channel = openChannel(bridge.address);
    const hello = await channel.hello(HELLO_TIMEOUT_MS);
    // Read before the second look, so a removal that lands after it still refuses this link.
    const generation = linkGeneration(serverId);
    const still = await claimedIdentity(fingerprint);
    if (ws.readyState !== ws.OPEN) return;
    if (
      still?.serverId !== serverId ||
      still.kind === "retired" ||
      !linkAdmissible(serverId, generation)
    )
      return void ws.close(LINK_CLOSE.revoked, "trust revoked");
    // One identity, one live link: a second machine holding the key is refused while the first answers.
    const open = currentLink(serverId);
    if (open && (await answers(open))) {
      identityCopied(claimed, "both-answer");
      void import("../../agent/cert-renewal").then((m) =>
        m.rotateAfterCopy(serverId),
      );
      return void ws.close(LINK_CLOSE.copied, "identity in use");
    }
    if (ws.readyState !== ws.OPEN) return;
    if (still.kind === "next" && (await promoteNextCert(serverId, fingerprint)))
      // A rotation cut halfway: the retired key is cut off at every cluster relay now, as a whole one does.
      void import("../../data/clusters/relay").then((m) =>
        m.pushRostersForServer(serverId),
      );
    // As the door admits it, before anyone hears it come up (ADR-0041).
    await recordFirstLink(serverId);
    await recordLinkOrigin(
      serverId,
      from,
      hello.capabilities?.includes(HOST_ADDRESSES_CAPABILITY)
        ? hello.publicAddresses
        : [],
    );
    if (ws.readyState !== ws.OPEN) return;
    const verified: AgentLink = {
      id,
      serverId,
      pinnedFingerprint: fingerprint,
      client: channel.client,
      hello,
      openedAt,
      heardAt: () => heard,
      close(code, reason) {
        linkEnded(verified, reason);
        ws.close(code, reason);
        bridge.close();
      },
    };
    if (!admitLink(verified, generation))
      return void ws.close(LINK_CLOSE.revoked, "trust revoked");
    link = verified;
    void rotateIfDue(serverId);
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

async function panelClientCert() {
  const { issueControlPlaneClientCert, caCertPem } =
    await import("../../agent/pki");
  const client = await issueControlPlaneClientCert();
  return {
    certPem: client.certPem,
    keyPem: client.keyPem,
    caPem: await caCertPem(),
  };
}

// A dead link does not answer: its replacement is the same machine back, not a copy.
async function answers(open: AgentLink): Promise<boolean> {
  try {
    await linkChannel(open.client).hello(LINK_COPY_PING_MS);
    return true;
  } catch {
    return false;
  }
}

// A certificate past its date or due for its key's rotation gets a new key now, over the link just proven.
async function rotateIfDue(serverId: string): Promise<void> {
  try {
    const { renewAgentCertIfDue } = await import("../../agent/cert-renewal");
    const r = await renewAgentCertIfDue(serverId);
    if (r.renewed) console.log(`[cert-renewal] ${serverId}: ${r.reason}`);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    console.warn(`[cert-renewal] ${serverId} on its link: ${why}`);
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
