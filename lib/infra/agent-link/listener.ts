import "server-only";

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer } from "ws";

import { knock, type Door } from "./door";
import {
  LINK_MAX_PAYLOAD,
  LINK_PORT,
  LINK_SUBPROTOCOL,
  LINK_WATCHDOG_MS,
} from "./protocol";
import { doorClosed, doorOpened } from "./registry";

interface Running extends Door {
  server: http.Server;
  port: number;
}

// Next's standalone server cannot hold an upgraded connection, so the door has a listener of its own.
const KEY = Symbol.for("deplo.agent-link.listener");
const g = globalThis as unknown as { [KEY]?: Promise<Running> };

export function startAgentLinkListener(
  opts: { port?: number; host?: string; watchdogMs?: number } = {},
): Promise<{ port: number }> {
  g[KEY] ??= listen(opts).catch((e) => {
    g[KEY] = undefined;
    throw e;
  });
  return g[KEY].then(({ port }) => ({ port }));
}

export async function stopAgentLinkListener(): Promise<void> {
  const running = g[KEY];
  g[KEY] = undefined;
  if (!running) return;
  const door = await running.catch(() => null);
  if (!door) return;
  doorClosed();
  const closed = new Promise((r) => door.server.close(r));
  door.server.closeAllConnections();
  await Promise.race([closed, new Promise((r) => setTimeout(r, 1_000))]);
  for (const ws of door.wss.clients) ws.terminate();
  rmSync(door.socketDir, { recursive: true, force: true });
}

async function listen(opts: {
  port?: number;
  host?: string;
  watchdogMs?: number;
}): Promise<Running> {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: LINK_MAX_PAYLOAD,
    handleProtocols: (offered) =>
      offered.has(LINK_SUBPROTOCOL) ? LINK_SUBPROTOCOL : false,
  });
  const server = http.createServer((_req, res) => {
    res.writeHead(426, { connection: "close" }).end();
  });
  const socketDir = mkdtempSync(join(tmpdir(), "deplo-link-"));
  const door: Door = {
    wss,
    socketDir,
    watchdogMs: opts.watchdogMs ?? LINK_WATCHDOG_MS,
  };
  server.on("upgrade", (req, socket, head) => {
    void knock(door, req, socket, head);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? LINK_PORT, opts.host, () => resolve());
    });
  } catch (e) {
    rmSync(socketDir, { recursive: true, force: true });
    throw e;
  }
  server.on("error", (e) => console.error("[deplo] agent link listener:", e));
  doorOpened();
  const { port } = server.address() as { port: number };
  return { ...door, server, port };
}
