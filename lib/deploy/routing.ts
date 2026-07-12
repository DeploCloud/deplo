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
 * falls into the `defaultPort` group (the project/runtime default).
 *
 * The TLS triplet below is per-route so one container can serve some hosts over
 * HTTPS and others as plain HTTP, or issue certs via different ACME resolvers.
 * All three are optional and default to the long-standing HTTPS behaviour
 * (`entrypoint: "websecure"`, `tls: true`, resolver = the call's `certResolver`)
 * so a route that omits them stays byte-identical to the pre-existing output. */
export interface RouterRoute {
  name: string;
  port: number | null;
  /** Entrypoint this host's router binds to. Defaults to `websecure`. When
   * `tls` is false this is forced to `web` (plain HTTP can't sit on :443). */
  entrypoint?: string;
  /** Whether the router terminates TLS. Defaults to `true`. `false` ⇒ no
   * `tls`/`tls.certresolver` labels and the route is served on `web` (:80). */
  tls?: boolean;
  /** ACME cert resolver for this route's `tls.certresolver`. Defaults to the
   * call's top-level `certResolver`. Ignored when `tls` is false. */
  certResolver?: string;
  /** Traefik middlewares applied to this route's router, in order. Empty/absent
   * ⇒ no `middlewares=` label (byte-identical to the pre-middleware output). */
  middlewares?: string[];
  /** Path prefix this router matches, e.g. `/api`. The rule becomes
   * `(Host(`a`) || …) && PathPrefix(`/api`)` and the router gets a
   * `priority=<prefix length>` so a longer prefix wins on the same host. Empty/
   * absent ⇒ a `Host()`-only rule with no priority label (byte-identical to the
   * pre-path output). Normalised (single leading slash, no trailing slash, no
   * backtick) before use. */
  pathPrefix?: string;
  /** Strip `pathPrefix` before forwarding, via a generated `stripprefix`
   * middleware PREPENDED to `middlewares` (so user middlewares see the stripped
   * path). Ignored when `pathPrefix` is empty. */
  stripPrefix?: boolean;
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
  /**
   * App-wide HTTP Basic Auth. When set, a generated Traefik `basicauth`
   * middleware named `<name>` is DEFINED once (`traefik.http.middlewares.<name>.
   * basicauth.users=<users>`) and PREPENDED to every route's middleware chain, so
   * the credential gates ALL of the project's hostnames. `users` is the raw
   * htpasswd list (`user:$apr1$…,user2:$apr1$…`) with single `$` — the caller is
   * responsible for any docker-compose `$`→`$$` escaping of the EMITTED labels (a
   * single-image stack embeds them in a YAML label; a compose stack does too).
   * Absent ⇒ no middleware label and no chain change (byte-identical output).
   */
  basicAuth?: { name: string; users: string };
}

/**
 * Render the Traefik router + service labels for a set of routes.
 *
 * Default mode (no `perRouteKey`): group routes by their full signature —
 * effective port, the TLS triplet (entrypoint, tls on/off, cert resolver), the
 * middleware chain, and the path prefix (+strip flag) — and emit one router per
 * distinct signature. Two hosts fold into one OR-rule router only when ALL of
 * these match; a different `pathPrefix` always splits them (one Traefik rule
 * line carries one `PathPrefix`), and a longer prefix gets a higher router
 * `priority` so `/api` beats `/` on the same host. The default group (default port,
 * HTTPS via `websecure` with the call's default resolver) reuses `baseKey` bare;
 * every other signature suffixes `__<port>[-…]` (port first, preserving the
 * historical `__<port>` form when only the port differs; an `http`/entrypoint/
 * resolver segment is added only when those diverge from the HTTPS default). The
 * `__` separator CANNOT appear in a slug (slugs are `[a-z0-9-]`), so
 * `deplo-<slug>__<suffix>` can never byte-collide with another project's bare
 * `deplo-<otherslug>` key — Traefik router/service names are global across every
 * container on the host, so a `-`-only suffix could equal a sibling project
 * whose slug is literally `app-8080`. Order is deterministic (default group
 * first, then signatures sorted by id) so re-rendering an unchanged routing set
 * yields a byte-identical file.
 *
 * Per-route mode (`perRouteKey` set): one router per route under its own key, in
 * input order — for compose stacks that route distinct services to distinct
 * hosts.
 */
export function traefikRouterLabels(opts: RouterLabelOptions): string[] {
  // No routes ⇒ the container is deployed but NOT routed (e.g. a project whose
  // domains were all deleted — Deplo does not resurrect an auto domain). Emit a
  // single `traefik.enable=false` so the proxy ignores the container entirely,
  // rather than an empty-host `rule=` that Traefik would reject as invalid. No
  // router/service/network labels follow — there is nothing to route.
  if (opts.routes.length === 0) return ["traefik.enable=false"];

  const labels: string[] = ["traefik.enable=true"];
  if (opts.dockerNetwork) {
    labels.push(`traefik.docker.network=${opts.dockerNetwork}`);
  }

  // App-wide Basic Auth: DEFINE the generated middleware once, then prepend
  // its name to every route's chain so it gates ALL hostnames. The `$` in the
  // htpasswd hashes is doubled to `$$` — these labels are embedded in a
  // docker-compose YAML, which treats a single `$` as variable interpolation and
  // would corrupt the hash. Absent ⇒ this whole block is skipped, so a project
  // with no basic-auth users renders byte-identically to before.
  let routes = opts.routes;
  if (opts.basicAuth && opts.basicAuth.users) {
    const { name, users } = opts.basicAuth;
    labels.push(
      `traefik.http.middlewares.${name}.basicauth.users=${users.replace(/\$/g, "$$$$")}`,
    );
    routes = opts.routes.map((r) => ({
      ...r,
      middlewares: [name, ...(r.middlewares ?? [])],
    }));
  }

  if (opts.perRouteKey) {
    for (const route of routes) {
      const key = opts.perRouteKey(route);
      labels.push(...routerBlock(key, [route.name], resolveTls(route, opts), true));
    }
    return labels;
  }

  // Group by the full router signature: effective port plus the TLS triplet
  // (entrypoint, tls on/off, cert resolver). Two hosts fold into one OR-rule
  // router only when ALL of these match; any difference splits them into their
  // own router — that's what lets one container serve some hosts over HTTPS and
  // others as plain HTTP, or via different ACME resolvers.
  const groups = new Map<string, { sig: RouterSig; hosts: string[] }>();
  for (const r of routes) {
    const sig = resolveTls(r, opts);
    const id = sigId(sig);
    const g = groups.get(id) ?? { sig, hosts: [] };
    g.hosts.push(r.name);
    groups.set(id, g);
  }
  // The default-port group (default port, websecure, TLS on, the call's default
  // resolver) keeps the bare `baseKey`; it always sorts first so re-rendering an
  // unchanged routing set yields byte-identical output. Every other signature
  // suffixes a deterministic, slug-safe key and sorts after it.
  const defaultId = sigId({
    port: opts.defaultPort,
    entrypoint: "websecure",
    tls: true,
    certResolver: opts.certResolver,
    middlewares: [],
    pathPrefix: "",
    stripPrefix: false,
  });
  // Default group first; the rest by ascending port (NUMERIC, so :80 sorts
  // before :100 — a string sort of the id would not), then by id for a stable
  // tiebreak when two signatures share a port (e.g. HTTP vs a custom resolver).
  const ordered = [...groups.entries()].sort(([a, ga], [b, gb]) => {
    if (a === defaultId) return -1;
    if (b === defaultId) return 1;
    if (ga.sig.port !== gb.sig.port) return ga.sig.port - gb.sig.port;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  // A single router auto-binds its same-named service, so the explicit
  // `.service` label is omitted unless forced — keeping the single-router output
  // byte-identical to its long-standing form (no spurious reroute restart).
  const withApp = opts.alwaysService || ordered.length > 1;
  for (const [id, g] of ordered) {
    const key =
      id === defaultId
        ? opts.baseKey
        : `${opts.baseKey}__${sigSuffix(g.sig, opts.certResolver)}`;
    labels.push(...routerBlock(key, g.hosts, g.sig, withApp));
  }
  return labels;
}

/** A fully-resolved router signature: the effective container port, the TLS
 * triplet, and the middleware chain. Routes sharing one signature fold into a
 * single OR-rule router; any difference (including a different chain) splits
 * them into their own router. */
interface RouterSig {
  port: number;
  entrypoint: string;
  tls: boolean;
  certResolver: string;
  /** Middlewares applied in order. Empty ⇒ no `middlewares=` label. */
  middlewares: string[];
  /** Normalised path prefix (single leading slash, no trailing slash). Empty ⇒
   * a `Host()`-only rule, no `PathPrefix`, no `priority` label. */
  pathPrefix: string;
  /** Strip `pathPrefix` via a generated `stripprefix` middleware. Always false
   * when `pathPrefix` is empty (strip-without-path is a no-op). */
  stripPrefix: boolean;
}

/** Resolve a route's signature, applying the call-level defaults. `tls: false`
 * forces the `web` entrypoint (plain HTTP can't bind :443) and drops the
 * resolver, so HTTP-only routes always share one canonical signature. The
 * middleware chain is normalised (trimmed, blanks dropped) but order-preserving
 * — middleware order is significant in Traefik. */
function resolveTls(route: RouterRoute, opts: RouterLabelOptions): RouterSig {
  const port = route.port ?? opts.defaultPort;
  const tls = route.tls ?? true;
  const middlewares = (route.middlewares ?? [])
    .map((m) => m.trim())
    .filter(Boolean);
  const pathPrefix = normalizeRulePath(route.pathPrefix);
  // Strip is meaningless without a path, so collapse it to false there — that
  // keeps a strip-without-path route in the same (default) signature as a bare
  // route and emits no stripprefix label (byte-identical to today).
  const stripPrefix = pathPrefix !== "" && (route.stripPrefix ?? false);
  if (!tls) {
    return {
      port,
      entrypoint: "web",
      tls: false,
      certResolver: "",
      middlewares,
      pathPrefix,
      stripPrefix,
    };
  }
  return {
    port,
    entrypoint: route.entrypoint ?? "websecure",
    tls: true,
    certResolver: route.certResolver ?? opts.certResolver,
    middlewares,
    pathPrefix,
    stripPrefix,
  };
}

/** Normalise a router path prefix: trim, drop a trailing slash, force a single
 * leading slash, and strip backticks (the value is interpolated into a Traefik
 * backtick literal — a stray backtick would break the rule grammar). Empty or a
 * bare `/` collapses to `""` (no PathPrefix). The data layer's `normalizePath`
 * does the same cleaning at persist time; doing it here too keeps the grammar
 * self-contained and lets synthetic routes pass a raw value safely. */
function normalizeRulePath(input?: string): string {
  let p = (input ?? "").trim().replace(/`/g, "");
  if (!p) return "";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, ""); // drop trailing slash(es)
  return p === "" ? "" : p;
}

/** Stable grouping id for a signature — two routes group iff this matches. The
 * middleware chain is part of the id (order included) so hosts with different
 * chains never share a router. */
function sigId(sig: RouterSig): string {
  return `${sig.port}|${sig.entrypoint}|${sig.tls ? 1 : 0}|${sig.certResolver}|${sig.middlewares.join(",")}|${sig.pathPrefix}|${sig.stripPrefix ? 1 : 0}`;
}

/**
 * Slug-safe key suffix distinguishing a non-default router. The port leads
 * (preserving the historical `__<port>` form when only the port differs); the
 * entrypoint and resolver are appended ONLY when they diverge from the HTTPS
 * default (`websecure` + `defaultResolver`) so a pure port-override route keeps
 * its long-standing `__<port>` key — older deployments don't churn router names.
 * Every segment is sanitised to `[a-z0-9-]`, and the `__` group separator can't
 * appear in a slug, so these keys never byte-collide with a sibling project's
 * bare `deplo-<slug>` router.
 */
function sigSuffix(sig: RouterSig, defaultResolver: string): string {
  const parts = [String(sig.port)];
  if (!sig.tls) parts.push("http");
  else {
    if (sig.entrypoint !== "websecure") parts.push(safe(sig.entrypoint));
    if (sig.certResolver !== defaultResolver) parts.push(safe(sig.certResolver));
  }
  // A path prefix must distinguish the key. `safe(pathPrefix)` alone is NOT
  // injective (`/a/b` and `/a-b` both collapse to `a-b`, and the strip flag is
  // ambiguous with a path literally containing "strip"), so two distinct
  // signatures could collide on one router name — two Traefik routers with the
  // same name, last-write-wins. Pair the readable segment with a short hash of
  // the RAW path + strip flag, which is injective for our purposes, so two
  // signatures that differ in sigId() can never share a key.
  if (sig.pathPrefix) {
    parts.push("path", safe(sig.pathPrefix), hash6(`${sig.pathPrefix}|${sig.stripPrefix ? 1 : 0}`));
    if (sig.stripPrefix) parts.push("strip");
  }
  // A middleware chain must distinguish the key too: two routes identical except
  // for their chain would otherwise share a key (an invalid duplicate router).
  // The sanitised, ordered names keep the key deterministic and chain-distinct.
  if (sig.middlewares.length) parts.push("mw", ...sig.middlewares.map(safe));
  return parts.join("-");
}

/** Lower-case and collapse anything outside `[a-z0-9-]` so a router key derived
 * from a resolver/entrypoint name can never break the Traefik label grammar. */
function safe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** A short, stable, slug-safe hash of an arbitrary string — the injective
 * discriminator in a router-key suffix where `safe()` alone would collapse
 * distinct inputs to the same segment. Deterministic (no crypto/random) so an
 * unchanged routing set re-renders byte-identically. 32-bit FNV-1a, base36,
 * zero-padded to 6 chars. */
function hash6(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/** One router + its service: rule (OR of Host() matchers), entrypoint, optional
 * TLS + resolver, optional middleware chain, optional explicit service binding,
 * and the loadbalancer target port. A non-TLS signature emits only the `web`
 * entrypoint — no `tls` labels. */
function routerBlock(
  key: string,
  hosts: string[],
  sig: RouterSig,
  withApp: boolean,
): string[] {
  const hostRule = hosts.map((d) => `Host(\`${d}\`)`).join(" || ");
  // A `PathPrefix` is && to the whole Host OR-group: `&&` binds tighter than
  // `||`, so the parens are mandatory or only the LAST host would be path-gated.
  // No path ⇒ the bare host join (the exact pre-path expression) so an existing
  // route's rule label is byte-identical.
  const rule = sig.pathPrefix
    ? `(${hostRule}) && PathPrefix(\`${sig.pathPrefix}\`)`
    : hostRule;
  // A generated stripprefix middleware (Traefik @docker provider, named off the
  // already-unique router key) prepended to the user chain, so user middlewares
  // (auth, rate-limit) see the stripped path the app sees. The name is bare
  // (unqualified) because it lives in the same docker provider as this router;
  // user entries may be provider-qualified (`auth@file`) and are kept verbatim.
  const stripName = sig.stripPrefix ? `${key}-stripprefix` : null;
  const middlewares = stripName ? [stripName, ...sig.middlewares] : sig.middlewares;
  return [
    `traefik.http.routers.${key}.rule=${rule}`,
    `traefik.http.routers.${key}.entrypoints=${sig.entrypoint}`,
    ...(sig.tls
      ? [
          `traefik.http.routers.${key}.tls=true`,
          `traefik.http.routers.${key}.tls.certresolver=${sig.certResolver}`,
        ]
      : []),
    // A longer prefix wins on the same host: Traefik orders routers by priority
    // (default = rule length), but we set it explicitly to the prefix length so
    // `/api` deterministically beats `/` regardless of emission order. Omitted
    // when there's no path so a path-less route stays byte-identical.
    ...(sig.pathPrefix
      ? [`traefik.http.routers.${key}.priority=${sig.pathPrefix.length}`]
      : []),
    ...(stripName
      ? [`traefik.http.middlewares.${stripName}.stripprefix.prefixes=${sig.pathPrefix}`]
      : []),
    ...(middlewares.length
      ? [`traefik.http.routers.${key}.middlewares=${middlewares.join(",")}`]
      : []),
    ...(withApp ? [`traefik.http.routers.${key}.service=${key}`] : []),
    `traefik.http.services.${key}.loadbalancer.server.port=${sig.port}`,
  ];
}
