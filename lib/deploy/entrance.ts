// A cluster domain that answers on every server (ADR-0048): each server's proxy passes its TLS, untouched, and
// its certificate checks to that server's entrance forwarder, whose agent carries them to a server running the App.

/** The proxy's internal entrypoint: on its own loopback, never published, and the only one trusting a PROXY header. */
export const ENTRANCE_ENTRYPOINT = "entrance";
export const ENTRANCE_PORT = 8443;

/** The entrance forwarder's name on the proxy's network, and the transport that sends it the PROXY header. */
export const ENTRANCE_ALIAS = "deplo-entrance";
export const ENTRANCE_TRANSPORT = "deplo-entrance";

/** Deplo's challenge router: above every router Deplo writes, so every other domain's checks pass as before. */
export const ACME_PRIORITY = 2_000_000_000;
/** An App's own check router, the one thing that passes before it. */
export const ENTRANCE_ACME_PRIORITY = ACME_PRIORITY + 1;

export const ACME_PATH = "/.well-known/acme-challenge/";

const PORT_BASE = 20_000;

/** The App's two ports on every server's entrance forwarder: its TLS, then its certificate checks. */
export function entrancePorts(slot: number): { tls: number; web: number } {
  return { tls: PORT_BASE + 2 * slot, web: PORT_BASE + 2 * slot + 1 };
}

/** The most slots the ports leave room for. */
export const MAX_ENTRANCE_SLOT = Math.floor((65_535 - PORT_BASE - 1) / 2);

export function entranceName(appId: string): string {
  return `deplo-entrance-${appId}`;
}

type EntranceRoutes = {
  tcp: {
    routers: Record<string, object>;
    services: Record<string, object>;
  };
  http: {
    routers: Record<string, object>;
    services: Record<string, object>;
  };
};

/**
 * One App's routers and services on every server's proxy, as Traefik dynamic configuration: its hostnames by SNI on
 * `websecure`, passed through with the PROXY header, and their checks on `web`. The server agent takes no other form.
 */
export function entranceRoutes(
  appId: string,
  hosts: string[],
  slot: number,
): EntranceRoutes {
  const names = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].sort();
  if (names.length === 0)
    throw new Error("An App answers on every server only for its hostnames");
  const name = entranceName(appId);
  const acme = `${name}-acme`;
  const { tls, web } = entrancePorts(slot);
  const host = names.map((h) => `Host(\`${h}\`)`);
  const hostRule = host.length === 1 ? host[0] : `(${host.join(" || ")})`;
  return {
    tcp: {
      routers: {
        [name]: {
          rule: names.map((h) => `HostSNI(\`${h}\`)`).join(" || "),
          entryPoints: ["websecure"],
          service: name,
          tls: { passthrough: true },
        },
      },
      services: {
        [name]: {
          loadBalancer: {
            serversTransport: `${ENTRANCE_TRANSPORT}@file`,
            servers: [{ address: `${ENTRANCE_ALIAS}:${tls}` }],
          },
        },
      },
    },
    http: {
      routers: {
        [acme]: {
          rule: `${hostRule} && PathPrefix(\`${ACME_PATH}\`)`,
          entryPoints: ["web"],
          service: acme,
          priority: ENTRANCE_ACME_PRIORITY,
        },
      },
      services: {
        [acme]: {
          loadBalancer: {
            servers: [{ url: `http://${ENTRANCE_ALIAS}:${web}` }],
          },
        },
      },
    },
  };
}
