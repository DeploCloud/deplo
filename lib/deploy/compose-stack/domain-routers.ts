import "server-only";

import { certResolver } from "../domains";
import { traefikRouterLabels, hash6 } from "../routing";
import { declaredPort } from "../compose-lint/routing";
import { serviceReservedClaim } from "../compose-lint/networks";
import { mergeLabels } from "./service-stamp";
import type { WireApp } from "./stack-network";
import type { App, ComposeStackInput } from "./types";

// Traefik routing labels for one exposed service, via the shared routing module
// (compose-stack flavour: a fixed per-route key, the `docker.network` pin, and an
// always-explicit `.service` label).
function traefikLabels(opts: {
  router: string;
  network: string;
  domains: string[];
  port: number;
  // The route's OWN TLS triplet (`domainTlsConfig` of its stored row). Absent ⇒ the
  // shared default (websecure + the instance resolver).
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  pathPrefix?: string;
  stripPrefix?: boolean;
  // Absolute base URL this host permanently redirects to (the canonical half of a
  // `www` pair). Absent/empty ⇒ the router serves the service.
  redirectTo?: string;
  // App-wide Basic Auth: a generated `basicauth` middleware, prepended to this
  // router's chain. Absent ⇒ no auth.
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
  // One router named `router`, serving every host in `domains` on `port` (a single
  // OR-rule).
  return traefikRouterLabels({
    baseKey: router,
    routes: domains.map((name) => ({
      name,
      port: null,
      // Carried per route, not left to the default. Every compose app on a plain
      // `.nip.io` was reachable only at an address the panel never printed.
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

// wireDomainRoutes stamps one Traefik router per routed domain onto its named compose
// service: the `domains` table IS the routing. A route with no service (or a service
// not in the stack) can't be wired - skipped rather than pointed at nothing.
export function wireDomainRoutes(opts: {
  services: Record<string, App>;
  input: ComposeStackInput;
  basicAuth?: { name: string; users: string };
  wireApp: WireApp;
}): void {
  const { services, input, basicAuth, wireApp } = opts;
  const name = input.name;
  const portOf = (service: string): number => {
    return declaredPort(services[service]) ?? 80; // conventional web port when the service declares none
  };
  for (const route of input.domainRoutes) {
    const service = route.service;
    if (!service || !services[service]) continue;
    // A row written before the domain layer refused these names: wiring it would put
    // the platform's own name on the shared network, and a throw would take the WHOLE
    // stack down with it - deploy included. Skip the route instead.
    const reservedClaim = serviceReservedClaim(service, services[service]);
    if (reservedClaim) {
      // Never in silence: the deploy went green with a hostname answering nothing.
      input.onWarn?.(
        `\`${route.name}\` points at service \`${service}\`, which answers to ` +
          `\`${reservedClaim}\` - a name Deplo's own infrastructure uses - so it is ` +
          `kept off the network and the domain will not answer. Rename the service, ` +
          `or its \`hostname:\`.`,
      );
      continue;
    }
    if (!wireApp(service)) {
      // `network_mode` takes a service off every network of its own, so Traefik has
      // nothing to forward to and the domain answers nothing.
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
        // `safe()` alone collapses `.`/`/` to `-`, so `api.example.com` and
        // `api-example.com` would produce the SAME router key and mergeLabels would
        // silently drop one router.
        router: `${keySeed.replace(/[^a-zA-Z0-9_-]/g, "-")}-${hash6(keySeed)}`,
        domains: [route.name],
        port,
        // The row's own choice, resolved by `domainTlsConfig` before it got here. A
        // route that terminates no TLS must land on `web`.
        entrypoint: route.entrypoint,
        tls: route.tls,
        certResolver: route.certResolver,
        pathPrefix: route.pathPrefix,
        stripPrefix: route.stripPrefix,
        // A `www` host still needs a router pointing at a real service (Traefik
        // requires one), but its redirect middleware answers 301 first.
        redirectTo: route.redirectTo,
        ...(basicAuth ? { basicAuth } : {}),
      }),
    );
  }
}
