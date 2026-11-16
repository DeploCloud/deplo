// A cluster domain that answers on every server (ADR-0048): each server's proxy passes its TLS, untouched, and
// its certificate checks to that server's answer forwarder, whose agent carries them to a server running the App.

/** The proxy's internal entrypoint: on its own loopback, never published, and the only one trusting a PROXY header. */
export const ANSWER_ENTRYPOINT = "answer";
export const ANSWER_PORT = 8443;

/** The answer forwarder's name on the proxy's network, and the transport that sends it the PROXY header. */
export const ANSWER_ALIAS = "deplo-answer";
export const ANSWER_TRANSPORT = "deplo-answer";

/** Deplo's challenge router: above every router Deplo writes, so every other domain's checks pass as before. */
export const ACME_PRIORITY = 2_000_000_000;
/** An App's own check router, the one thing that passes before it. */
export const ANSWER_ACME_PRIORITY = ACME_PRIORITY + 1;

export const ACME_PATH = "/.well-known/acme-challenge/";

const PORT_BASE = 20_000;

/** The App's two ports on every server's answer forwarder: its TLS, then its certificate checks. */
export function answerPorts(slot: number): { tls: number; web: number } {
  return { tls: PORT_BASE + 2 * slot, web: PORT_BASE + 2 * slot + 1 };
}

/** The most Apps of one cluster that answer on every server: what a server agent's table takes. */
export const MAX_ANSWER_APPS = 200;

/** What a cluster may set its servers' connection caps to; a quarter of the connections may wait. */
export const ANSWER_CONNECTIONS_RANGE = { min: 64, max: 65_536 } as const;

/** Each carried connection costs its server up to two 32 KB copy buffers (ADR-0048). */
export const ANSWER_CONNECTION_KB = 64;

/** The memory a server may spend on these connections: a quarter of it. */
export function answerConnectionsFit(memoryMb: number): number {
  return Math.floor((memoryMb * 1024) / 4 / ANSWER_CONNECTION_KB);
}

/** What that many connections cost a server at most, in words. */
export function answerConnectionsCost(connections: number): string {
  const mb = (connections * ANSWER_CONNECTION_KB) / 1024;
  return mb >= 1024
    ? `${Math.round(mb / 102.4) / 10} GB`
    : `${Math.round(mb)} MB`;
}

/** Why these caps cannot be a cluster's, or null. The smallest server, when its memory is known, bounds them. */
export function answerLimitsRefusal(
  connections: number,
  waiting: number,
  smallest?: { name: string; memoryMb: number } | null,
): string | null {
  const { min, max } = ANSWER_CONNECTIONS_RANGE;
  if (!Number.isInteger(connections) || connections < min || connections > max)
    return `A server carries between ${min} and ${max} connections at once.`;
  if (
    smallest &&
    smallest.memoryMb > 0 &&
    connections > answerConnectionsFit(smallest.memoryMb)
  )
    return `${smallest.name} has ${smallest.memoryMb} MB of memory: at most ${answerConnectionsFit(smallest.memoryMb)} connections fit in a quarter of it, at up to ${ANSWER_CONNECTION_KB} KB each.`;
  const most = Math.floor(connections / 4);
  if (!Number.isInteger(waiting) || waiting < 1 || waiting > most)
    return `Between 1 and ${most} visitors can wait for one App: a quarter of the ${connections} connections may wait.`;
  return null;
}

/** The most slots the ports leave room for. */
export const MAX_ANSWER_SLOT = Math.floor((65_535 - PORT_BASE - 1) / 2);

export function answerName(appId: string): string {
  return `deplo-answer-${appId}`;
}

type AnswerRoutes = {
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
export function answerRoutes(
  appId: string,
  hosts: string[],
  slot: number,
): AnswerRoutes {
  const names = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].sort();
  if (names.length === 0)
    throw new Error("An App answers on every server only for its hostnames");
  const name = answerName(appId);
  const acme = `${name}-acme`;
  const { tls, web } = answerPorts(slot);
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
            serversTransport: `${ANSWER_TRANSPORT}@file`,
            servers: [{ address: `${ANSWER_ALIAS}:${tls}` }],
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
          priority: ANSWER_ACME_PRIORITY,
        },
      },
      services: {
        [acme]: {
          loadBalancer: {
            servers: [{ url: `http://${ANSWER_ALIAS}:${web}` }],
          },
        },
      },
    },
  };
}
