import "server-only";

import net from "node:net";
import { createWebSocketStream, type WebSocket } from "ws";

export interface LinkBridge {
  /** The channel's target. */
  address: string;
  /** Cuts the channel's side at once: every call on it fails as unreachable. */
  close(): void;
}

// grpc-js cannot be handed a socket it did not dial, so the link's channel dials a unix socket piped onto it.
export async function bridgeLink(
  ws: WebSocket,
  path: string,
): Promise<LinkBridge> {
  const stream = createWebSocketStream(ws);
  stream.on("error", () => {});
  let taken: net.Socket | null = null;
  const server = net.createServer((sock) => {
    // A second dial is grpc-js reconnecting after the link died: a link channel never outlives its link.
    if (taken) return void sock.destroy();
    taken = sock;
    server.close();
    sock.on("error", () => {});
    sock.pipe(stream).pipe(sock);
    sock.once("close", () => {
      if (ws.readyState === ws.OPEN) ws.close(1000, "channel closed");
    });
  });
  const close = () => {
    if (server.listening) server.close();
    taken?.destroy();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  if (ws.readyState !== ws.OPEN) {
    close();
    throw new Error("the link closed before its channel opened");
  }
  ws.once("close", close);
  return { address: `unix:${path}`, close };
}
