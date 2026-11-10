import { isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";

import { LINK_PATH } from "../infra/agent-link/protocol";
import { HOST_GATEWAY_ENTRY, RELAY_PATH, RELAY_TARGET } from "./cluster-relay";
import { defaultLogging } from "./resources";
import { linkTarget, TRAEFIK_CONTAINER } from "./traefik-stack";

// KEEP IN SYNC with install.sh, which carries this service over on an update by its name.
export const TUNNEL_SERVICE = "deplo-tunnel";
export const CLOUDFLARED_IMAGE = "cloudflare/cloudflared:2026.9.3";
const TOKEN_ENV = "TUNNEL_TOKEN";
// The platform's network: the panel and its proxy, and no tenant (ADR-0028).
const PLATFORM_NETWORK = "deplo";

export type TunnelIngressRule = {
  hostname?: string;
  path?: string;
  service: string;
};

// The connector dials the panel itself, not the proxy: the proxy would stand in for every visitor's address.
export function panelTunnelIngress(
  hostname: string,
  panelTarget: string,
  relay = false,
): TunnelIngressRule[] {
  return [
    { hostname, path: `^${LINK_PATH}$`, service: linkTarget(panelTarget) },
    // The cluster relay is carried the way the link is, on the same address (ADR-0042, ADR-0044).
    ...(relay
      ? [{ hostname, path: `^${RELAY_PATH}$`, service: RELAY_TARGET }]
      : []),
    { hostname, service: panelTarget },
    { service: "http_status:404" },
  ];
}

/** The proxy stack with Deplo's Cloudflare Tunnel connector in it, or without it when `token` is null. */
export function withPanelTunnel(
  currentYaml: string,
  token: string | null,
  opts: { relay?: boolean } = {},
): string {
  return withTunnelConnector(currentYaml, TUNNEL_SERVICE, token, opts);
}

const PROXY_TARGET = `http://${TRAEFIK_CONTAINER}:80`;

// An app's tunnel hands every hostname to the server's proxy, which routes it like any other domain.
export function appTunnelIngress(hostnames: string[]): TunnelIngressRule[] {
  const unique = [...new Set(hostnames.map((h) => h.toLowerCase()))].sort();
  return [
    ...unique.map((hostname) => ({ hostname, service: PROXY_TARGET })),
    { service: "http_status:404" },
  ];
}

// One connector per DNS provider account on a server. KEEP IN SYNC with install.sh, which carries it over by this prefix.
export function appTunnelService(providerId: string): string {
  return `deplo-dns-tunnel-${providerId.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

export function hasTunnelConnector(
  currentYaml: string,
  service: string,
): boolean {
  try {
    return parseStack(currentYaml).hasIn(["services", service]);
  } catch {
    return false;
  }
}

/** The stack with a Cloudflare Tunnel connector named `service`, or without it when `token` is null. */
export function withTunnelConnector(
  currentYaml: string,
  service: string,
  token: string | null,
  opts: { relay?: boolean } = {},
): string {
  const doc = parseStack(currentYaml);
  const services = doc.get("services", true);
  if (!isMap(services))
    throw new Error("This server's proxy configuration has no services in it");

  if (token === null) {
    services.delete(service);
    return doc.toString({ lineWidth: 0 });
  }
  const value = token.trim();
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value))
    throw new Error("Cloudflare returned a tunnel token Deplo cannot use");

  services.set(
    service,
    doc.createNode({
      image: CLOUDFLARED_IMAGE,
      container_name: service,
      restart: "unless-stopped",
      logging: defaultLogging(),
      command: ["tunnel", "--no-autoupdate", "run"],
      environment: [`${TOKEN_ENV}=${value}`],
      networks: [PLATFORM_NETWORK],
      // The relay is a process on the host: the connector reaches it by Docker's host gateway.
      ...(opts.relay ? { extra_hosts: [HOST_GATEWAY_ENTRY] } : {}),
    }),
  );
  const networks = doc.get("networks", true);
  if (!isMap(networks) || !networks.has(PLATFORM_NETWORK))
    doc.setIn(
      ["networks", PLATFORM_NETWORK],
      doc.createNode({ external: true }),
    );
  return doc.toString({ lineWidth: 0 });
}

/** Whether the panel's connector reaches the host by its gateway name, which a relay route needs (ADR-0044). */
export function panelTunnelReachesHost(currentYaml: string): boolean {
  try {
    const hosts = parseStack(currentYaml).getIn(
      ["services", TUNNEL_SERVICE, "extra_hosts"],
      true,
    );
    return (
      isSeq(hosts) &&
      hosts.items.some(
        (i) => isScalar(i) && String(i.value) === HOST_GATEWAY_ENTRY,
      )
    );
  } catch {
    return false;
  }
}

/** The token the stack's connector runs with; null when the stack has none. */
export function panelTunnelToken(currentYaml: string): string | null {
  let doc: Document.Parsed;
  try {
    doc = parseStack(currentYaml);
  } catch {
    return null;
  }
  const env = doc.getIn(["services", TUNNEL_SERVICE, "environment"], true);
  const prefix = `${TOKEN_ENV}=`;
  if (isSeq(env)) {
    for (const item of env.items) {
      const line = isScalar(item) ? String(item.value) : "";
      if (line.startsWith(prefix)) return line.slice(prefix.length) || null;
    }
  }
  if (isMap(env)) {
    const v = env.get(TOKEN_ENV);
    return typeof v === "string" && v ? v : null;
  }
  return null;
}

function parseStack(text: string): Document.Parsed {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(
      `Could not read this server's proxy configuration: ${doc.errors[0].message}`,
    );
  if (!isMap(doc.contents))
    throw new Error("This server's proxy configuration is not a compose file");
  return doc;
}
