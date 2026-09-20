import "server-only";

import { certResolver } from "../domains";
import { traefikRouterLabels, hash6 } from "../routing";
import { declaredPort } from "../compose-lint/routing";
import { serviceReservedClaim } from "../compose-lint/networks";
import { mergeLabels } from "./service-stamp";
import type { WireApp } from "./stack-network";
import type { App, ComposeStackInput } from "./types";

function traefikLabels(opts: {
  router: string;
  network: string;
  domains: string[];
  port: number;
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  pathPrefix?: string;
  stripPrefix?: boolean;
  redirectTo?: string;
  basicAuth?: { name: string; users: string };
}): string[] {
  const {
    router,
    domains,
    port,
    pathPrefix,
    stripPrefix,
    redirectTo,
    basicAuth,
  } = opts;
  return traefikRouterLabels({
    baseKey: router,
    routes: domains.map((name) => ({
      name,
      port: null,
      ...(opts.entrypoint ? { entrypoint: opts.entrypoint } : {}),
      ...(opts.tls === undefined ? {} : { tls: opts.tls }),
      ...(opts.certResolver === undefined
        ? {}
        : { certResolver: opts.certResolver }),
      pathPrefix,
      stripPrefix,
      redirectTo,
    })),
    defaultPort: port,
    certResolver: certResolver(),
    dockerNetwork: opts.network,
    alwaysService: true,
    ...(basicAuth ? { basicAuth } : {}),
  });
}

export function wireDomainRoutes(opts: {
  services: Record<string, App>;
  input: ComposeStackInput;
  basicAuth?: { name: string; users: string };
  wireApp: WireApp;
}): void {
  const { services, input, basicAuth, wireApp } = opts;
  const name = input.name;
  const portOf = (service: string): number => {
    return declaredPort(services[service]) ?? 80;
  };
  for (const route of input.domainRoutes) {
    const service = route.service;
    if (!service || !services[service]) continue;
    const reservedClaim = serviceReservedClaim(service, services[service]);
    // Skipped, never thrown: a throw here would take the whole stack down, deploy included.
    if (reservedClaim) {
      input.onWarn?.(
        `\`${route.name}\` points at service \`${service}\`, which answers to ` +
          `\`${reservedClaim}\` - a name Deplo's own infrastructure uses - so it is ` +
          `kept off the network and the domain will not answer. Rename the service, ` +
          `or its \`hostname:\`.`,
      );
      continue;
    }
    if (!wireApp(service)) {
      input.onWarn?.(
        `\`${route.name}\` points at service \`${service}\`, which sets ` +
          `\`network_mode\` and therefore joins no network Traefik can reach. The ` +
          `domain will not answer until that key is removed.`,
      );
      continue;
    }
    const port = route.port ?? portOf(service);
    const keySeed = `${name}-${service}-${route.name}${route.pathPrefix}`;
    mergeLabels(
      services[service] as App,
      traefikLabels({
        network: input.network,
        // `safe()` alone collapses `.` to `-`, so two hosts differing only there shared one router key.
        router: `${keySeed.replace(/[^a-zA-Z0-9_-]/g, "-")}-${hash6(keySeed)}`,
        domains: [route.name],
        port,
        entrypoint: route.entrypoint,
        tls: route.tls,
        // Carried per route: a compose app on a plain generated host answered only at an unprinted address.
        certResolver: route.certResolver,
        pathPrefix: route.pathPrefix,
        stripPrefix: route.stripPrefix,
        redirectTo: route.redirectTo,
        ...(basicAuth ? { basicAuth } : {}),
      }),
    );
  }
}
