import "server-only";

import {
  deploHostMachineAddresses,
  isDeploHostServer,
  runsInContainer,
} from "../../deploy/domains";
import { LINK_PORT } from "../../infra/agent-link/protocol";
import { instancePublicBaseUrl } from "../instance-settings/settings-store";

type ServerAddress = { ip?: string; host?: string };

/** Where a server's agent calls home: the panel's own server over loopback, before the proxy's ports are Deplo's. */
export async function bootstrapBaseUrl(server: ServerAddress): Promise<string> {
  if (!isDeploHostServer(server)) return instancePublicBaseUrl();
  return `http://127.0.0.1:${hostPort(process.env.DEPLO_PANEL_PORT, 3000)}`;
}

/** Where a server's agent links (ADR-0040): the panel's own machine over loopback, never through its public address. */
export async function agentLinkUrl(
  server: ServerAddress,
  h?: Headers,
): Promise<string> {
  if (!linksOverLoopback(server)) return instancePublicBaseUrl(h);
  return `http://127.0.0.1:${loopbackLinkPort()}`;
}

/** Only a server provably on the panel's machine, and only while a port there reaches the door. */
export function linksOverLoopback(server: ServerAddress): boolean {
  return (
    loopbackLinkPort() !== null &&
    isDeploHostServer(server, deploHostMachineAddresses())
  );
}

// The installer names the port it published; a container that names none published none.
function loopbackLinkPort(): number | null {
  const port = Number(process.env.DEPLO_LINK_PORT?.trim());
  if (Number.isInteger(port) && port > 0) return port;
  return runsInContainer() ? null : LINK_PORT;
}

// The installer names the host ports it published; a bare process listens on its own.
function hostPort(raw: string | undefined, fallback: number): number {
  const port = Number(raw?.trim());
  return Number.isInteger(port) && port > 0 ? port : fallback;
}
