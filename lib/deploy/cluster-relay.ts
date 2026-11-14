// The cluster relay's door (ADR-0044). Its side is deplo-cluster internal/wire.

/** Where a cluster party reaches the relay on the panel's own address, beside the agent link. */
export const RELAY_PATH = "/api/cluster/relay";

/** The port the relay answers on beside the proxy, on loopback and the proxy's gateway only. */
export const RELAY_PORT = 3002;

// The relay is a process on the host, so the proxy reaches it through Docker's host gateway.
export const HOST_GATEWAY_ALIAS = "host.docker.internal";
export const HOST_GATEWAY_ENTRY = `${HOST_GATEWAY_ALIAS}:host-gateway`;

export const RELAY_TARGET = `http://${HOST_GATEWAY_ALIAS}:${RELAY_PORT}`;

/** Whether `target` is a process on the host, which a container reaches only by the gateway name. */
export function throughHostGateway(target: string | null | undefined): boolean {
  try {
    return new URL(target ?? "").hostname === HOST_GATEWAY_ALIAS;
  } catch {
    return false;
  }
}
