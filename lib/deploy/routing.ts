/**
 * Traefik routing labels — the one module that knows the label grammar.
 *
 * Deplo fronts every routed runtime (production single-image stacks, compose
 * stacks, and dev-container previews) with one Traefik proxy via Docker provider
 * labels: TLS through Let's Encrypt, one router+service per distinct target port.
 * This grammar used to be re-implemented in four places with subtly divergent
 * rules; it now lives here, and each call site is an adapter that hands it a
 * route list. The differences that DO matter between call sites are explicit
 * options, not forks of the algorithm:
 *
 *  - `dockerNetwork` — emit `traefik.docker.network=<net>`. Compose stacks and
 *    dev containers pin the network (they sit on more than the deplo network);
 *    a single-image production stack joins only `deplo`, so it omits the label
 *    to stay byte-identical to its long-standing output.
 *  - `alwaysService` — always emit the explicit `.service` label. A single
 *    router auto-binds its same-named service, so the production single-image
 *    path OMITS it when there's exactly one router (byte-identical to its old
 *    output). Compose/dev always emitted it, so they pass `alwaysService: true`.
 *
 * Pure on purpose: no store, no docker, no `server-only`. Inputs in, label
 * strings out — its interface IS its test surface.
 */

/** A routable hostname and the container port its router targets. `port: null`
 * falls into the `defaultPort` group (the project/runtime default). */
export interface RouterRoute {
  name: string;
  port: number | null;
}

export interface RouterLabelOptions {
  /**
   * The router/service key for the default-port group, e.g. `deplo-<slug>`. A
   * non-default port group suffixes this with `__<port>` (see below). When
   * `perRouteKey` is given, that overrides the key per route instead.
   */
  baseKey: string;
  routes: RouterRoute[];
  /** Container port a `null`-override route targets. */
  defaultPort: number;
  /** ACME cert resolver name for `tls.certresolver`. */
  certResolver: string;
  /** Emit `traefik.docker.network=<net>` (compose stacks / dev containers). */
  dockerNetwork?: string;
  /** Always emit the explicit `.service` label, even for a single router. */
  alwaysService?: boolean;
  /**
   * Per-route router/service key. When set, each route gets its own router under
   * this key (no per-port grouping) — used by compose stacks, where a service
   * exposed on several hosts/ports needs a distinct key per route. When unset,
   * routes are grouped by effective port under `baseKey` (the single-image path).
   */
  perRouteKey?: (route: RouterRoute) => string;
}

/**
 * Render the Traefik router + service labels for a set of routes.
 *
 * Default mode (no `perRouteKey`): group routes by effective port and emit one
 * router per distinct port. The default-port group reuses `baseKey` bare; every
 * other port group suffixes `__<port>`. The `__` separator CANNOT appear in a
 * slug (slugs are `[a-z0-9-]`), so `deplo-<slug>__<port>` can never byte-collide
 * with another project's bare `deplo-<otherslug>` key — Traefik router/service
 * names are global across every container on the host, so a `-`-only suffix
 * could equal a sibling project whose slug is literally `app-8080`. Order is
 * deterministic (default-port group first, then ascending) so re-rendering an
 * unchanged routing set yields a byte-identical file.
 *
 * Per-route mode (`perRouteKey` set): one router per route under its own key, in
 * input order — for compose stacks that route distinct services to distinct
 * hosts.
 */
export function traefikRouterLabels(opts: RouterLabelOptions): string[] {
  const labels: string[] = ["traefik.enable=true"];
  if (opts.dockerNetwork) {
    labels.push(`traefik.docker.network=${opts.dockerNetwork}`);
  }

  if (opts.perRouteKey) {
    for (const route of opts.routes) {
      const key = opts.perRouteKey(route);
      const port = route.port ?? opts.defaultPort;
      labels.push(...routerBlock(key, [route.name], port, opts.certResolver, true));
    }
    return labels;
  }

  // Group by effective port: its override, else the runtime default. This is
  // the same override-or-default fold as `effectivePortFor` in ./ports, applied
  // here to a route list whose `defaultPort` the caller already resolved.
  const byPort = new Map<number, string[]>();
  for (const r of opts.routes) {
    const p = r.port ?? opts.defaultPort;
    const hosts = byPort.get(p) ?? [];
    hosts.push(r.name);
    byPort.set(p, hosts);
  }
  // Default-port group first, then remaining ports ascending — stable output.
  const ports = [
    ...(byPort.has(opts.defaultPort) ? [opts.defaultPort] : []),
    ...[...byPort.keys()]
      .filter((p) => p !== opts.defaultPort)
      .sort((a, b) => a - b),
  ];
  // A single router auto-binds its same-named service, so the explicit
  // `.service` label is omitted unless forced — keeping the single-port output
  // byte-identical to its long-standing form (no spurious reroute restart).
  const withService = opts.alwaysService || ports.length > 1;
  for (const p of ports) {
    const key = p === opts.defaultPort ? opts.baseKey : `${opts.baseKey}__${p}`;
    labels.push(
      ...routerBlock(key, byPort.get(p) ?? [], p, opts.certResolver, withService),
    );
  }
  return labels;
}

/** One router + its service: rule (OR of Host() matchers), TLS, optional
 * explicit service binding, and the loadbalancer target port. */
function routerBlock(
  key: string,
  hosts: string[],
  port: number,
  certResolver: string,
  withService: boolean,
): string[] {
  const rule = hosts.map((d) => `Host(\`${d}\`)`).join(" || ");
  return [
    `traefik.http.routers.${key}.rule=${rule}`,
    `traefik.http.routers.${key}.entrypoints=websecure`,
    `traefik.http.routers.${key}.tls=true`,
    `traefik.http.routers.${key}.tls.certresolver=${certResolver}`,
    ...(withService ? [`traefik.http.routers.${key}.service=${key}`] : []),
    `traefik.http.services.${key}.loadbalancer.server.port=${port}`,
  ];
}
