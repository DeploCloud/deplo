// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

// https://deplo.build/docs/guides/networking/domains-and-https

/**
 * Traefik routing labels - the one module that knows the label grammar.
 */

/**
 * A routable hostname and the container port its router targets.
 */
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
  /**
   * Path prefix this router matches, e.g. `/api`. Normalised (single leading
   * slash, no trailing slash, no backtick) before use.
   */
  pathPrefix?: string;
  /** Strip `pathPrefix` before forwarding, via a generated `stripprefix`
   * middleware PREPENDED to `middlewares` (so user middlewares see the stripped
   * path). Ignored when `pathPrefix` is empty. */
  stripPrefix?: boolean;
  /**
   * Absolute base URL this host permanently redirects to, e.g.
   * `https://example.com` - the canonical half of a `www`/non-`www` pair.
   */
  redirectTo?: string;
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
  /** Emit `traefik.docker.network=<net>` (compose stacks). */
  dockerNetwork?: string;
  /** Always emit the explicit `.service` label, even for a single router. */
  alwaysService?: boolean;
  /**
   * Per-route router/service key.
   */
  perRouteKey?: (route: RouterRoute) => string;
  /**
   * App-wide HTTP Basic Auth.
   */
  basicAuth?: { name: string; users: string };
}

/**
 * Priority floor for a router that carries a `PathPrefix`, added on top of the
 * prefix length.
 */
const PATH_PRIORITY_BASE = 1_000_000;

/**
 * Render the Traefik router + service labels for a set of routes. Order is
 * deterministic (default group first, then signatures sorted by id) so
 * re-rendering an unchanged routing set yields a byte-identical file.
 */
export function traefikRouterLabels(opts: RouterLabelOptions): string[] {
  // No routes ⇒ the container is deployed but NOT routed (e.g. a project whose
  // domains were all deleted - Deplo does not resurrect an auto domain).
  if (opts.routes.length === 0) return ["traefik.enable=false"];

  const labels: string[] = ["traefik.enable=true"];
  if (opts.dockerNetwork) {
    labels.push(`traefik.docker.network=${opts.dockerNetwork}`);
  }

  // App-wide Basic Auth: DEFINE the generated middleware once, then prepend its name
  // to every route's chain so it gates ALL hostnames.
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
      labels.push(
        ...routerBlock(key, [route.name], resolveTls(route, opts), true),
      );
    }
    return labels;
  }

  // Group by the full router signature: effective port plus the TLS triplet
  // (entrypoint, tls on/off, cert resolver), and the redirect target.
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
  // unchanged routing set yields byte-identical output.
  const defaultId = sigId({
    port: opts.defaultPort,
    entrypoint: "websecure",
    tls: true,
    certResolver: opts.certResolver,
    middlewares: [],
    pathPrefix: "",
    stripPrefix: false,
    redirectTo: "",
  });
  // Default group first; the rest by ascending port (NUMERIC, so :80 sorts
  // before :100 - a string sort of the id would not), then by id for a stable
  // tiebreak when two signatures share a port (e.g. HTTP vs a custom resolver).
  const ordered = [...groups.entries()].sort(([a, ga], [b, gb]) => {
    if (a === defaultId) return -1;
    if (b === defaultId) return 1;
    if (ga.sig.port !== gb.sig.port) return ga.sig.port - gb.sig.port;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  // A single router auto-binds its same-named service, so the explicit
  // `.service` label is omitted unless forced - keeping the single-router output
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

/**
 * A fully-resolved router signature: the effective container port, the TLS
 * triplet, and the middleware chain.
 */
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
  /** Absolute base URL this router 301s to. Empty ⇒ it serves the app. Part of
   * the signature: a redirecting host can never share a router with one that
   * serves, or the redirect would swallow the canonical host too. */
  redirectTo: string;
}

/**
 * Resolve a route's signature, applying the call-level defaults. `tls: false`
 * forces the `web` entrypoint (plain HTTP can't bind :443) and drops the resolver,
 * so HTTP-only routes always share one canonical signature.
 */
function resolveTls(route: RouterRoute, opts: RouterLabelOptions): RouterSig {
  const port = route.port ?? opts.defaultPort;
  const tls = route.tls ?? true;
  const middlewares = (route.middlewares ?? [])
    .map((m) => m.trim())
    .filter(Boolean);
  const pathPrefix = normalizeRulePath(route.pathPrefix);
  // Strip is meaningless without a path, so collapse it to false there - that
  // keeps a strip-without-path route in the same (default) signature as a bare
  // route and emits no stripprefix label (byte-identical to today).
  const stripPrefix = pathPrefix !== "" && (route.stripPrefix ?? false);
  const redirectTo = normalizeRedirectTarget(route.redirectTo);
  if (!tls) {
    return {
      port,
      entrypoint: "web",
      tls: false,
      certResolver: "",
      middlewares,
      pathPrefix,
      stripPrefix,
      redirectTo,
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
    redirectTo,
  };
}

/**
 * Clean a redirect target down to an absolute `scheme://host[/path]` with no
 * trailing slash.
 */
function normalizeRedirectTarget(input?: string): string {
  const t = (input ?? "").trim();
  if (!t) return "";
  if (!/^https?:\/\/[^\s/]+/i.test(t)) return "";
  return t.replace(/\/+$/, "");
}

/**
 * Normalise a router path prefix: trim, drop a trailing slash, force a single
 * leading slash, and strip backticks (the value is interpolated into a Traefik
 * backtick literal - a stray backtick would break the rule grammar).
 */
function normalizeRulePath(input?: string): string {
  let p = (input ?? "").trim().replace(/`/g, "");
  if (!p) return "";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, ""); // drop trailing slash(es)
  return p === "" ? "" : p;
}

/** Stable grouping id for a signature - two routes group iff this matches. The
 * middleware chain is part of the id (order included) so hosts with different
 * chains never share a router. */
function sigId(sig: RouterSig): string {
  return `${sig.port}|${sig.entrypoint}|${sig.tls ? 1 : 0}|${sig.certResolver}|${sig.middlewares.join(",")}|${sig.pathPrefix}|${sig.stripPrefix ? 1 : 0}|${sig.redirectTo}`;
}

/**
 * Slug-safe key suffix distinguishing a non-default router.
 */
function sigSuffix(sig: RouterSig, defaultResolver: string): string {
  const parts = [String(sig.port)];
  if (!sig.tls) parts.push("http");
  else {
    if (sig.entrypoint !== "websecure") parts.push(safe(sig.entrypoint));
    // An EMPTY resolver is TLS from the proxy's own certificate store (the
    // `custom` provider), not "the default one" - it needs a segment of its own,
    // and `safe("")` would contribute nothing and let the two share a key.
    if (sig.certResolver === "") parts.push("owncert");
    else if (sig.certResolver !== defaultResolver)
      parts.push(safe(sig.certResolver));
  }
  // A path prefix must distinguish the key. Pair the readable segment with a short
  // hash of the RAW path + strip flag, which is injective for our purposes, so two
  // signatures that differ in sigId() can never share a key.
  if (sig.pathPrefix) {
    parts.push(
      "path",
      safe(sig.pathPrefix),
      hash6(`${sig.pathPrefix}|${sig.stripPrefix ? 1 : 0}`),
    );
    if (sig.stripPrefix) parts.push("strip");
  }
  // A middleware chain must distinguish the key too: two routes identical except
  // for their chain would otherwise share a key (an invalid duplicate router).
  // The sanitised, ordered names keep the key deterministic and chain-distinct.
  if (sig.middlewares.length) parts.push("mw", ...sig.middlewares.map(safe));
  // Same reasoning for a redirect: the target is hashed rather than spelled out
  // (a URL sanitises to an unbounded, non-injective segment) so two hosts
  // redirecting to different targets can never collide on one router name.
  if (sig.redirectTo) parts.push("redirect", hash6(sig.redirectTo));
  return parts.join("-");
}

/** Lower-case and collapse anything outside `[a-z0-9-]` so a router key derived
 * from a resolver/entrypoint name can never break the Traefik label grammar. */
function safe(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * A short, stable, slug-safe hash of an arbitrary string - the injective
 * discriminator in a router-key suffix where `safe()` alone would collapse
 * distinct inputs to the same segment.
 */
export function hash6(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/**
 * One router + its service: rule (OR of Host() matchers), entrypoint, optional TLS
 * + resolver, optional middleware chain, optional explicit service binding, and
 * the loadbalancer target port.
 */
function routerBlock(
  key: string,
  hosts: string[],
  sig: RouterSig,
  withApp: boolean,
): string[] {
  const hostRule = hosts.map((d) => `Host(\`${d}\`)`).join(" || ");
  // A `PathPrefix` is && to the whole Host OR-group: `&&` binds tighter than `||`, so
  // the parens are mandatory or only the LAST host would be path-gated.
  const rule = sig.pathPrefix
    ? `(${hostRule}) && PathPrefix(\`${sig.pathPrefix}\`)`
    : hostRule;
  // A generated stripprefix middleware (Traefik @docker provider, named off the
  // already-unique router key) prepended to the user chain, so user middlewares
  // (auth, rate-limit) see the stripped path the app sees.
  const stripName = sig.stripPrefix ? `${key}-stripprefix` : null;
  // A generated redirectregex middleware, at the HEAD of the chain: this router
  // exists to answer 301, so it must fire before basic auth (nobody should be asked
  // to log in on the hostname they are being sent away from), before stripprefix, and
  const redirectName = sig.redirectTo ? `${key}-redirect` : null;
  const middlewares = [
    ...(redirectName ? [redirectName] : []),
    ...(stripName ? [stripName] : []),
    ...sig.middlewares,
  ];
  return [
    `traefik.http.routers.${key}.rule=${rule}`,
    `traefik.http.routers.${key}.entrypoints=${sig.entrypoint}`,
    ...(sig.tls
      ? [
          `traefik.http.routers.${key}.tls=true`,
          // No resolver ⇒ no `certresolver` label: TLS comes from a certificate already in
          // the proxy's store (the `custom` provider).
          ...(sig.certResolver
            ? [
                `traefik.http.routers.${key}.tls.certresolver=${sig.certResolver}`,
              ]
            : []),
        ]
      : []),
    // A path router MUST outrank the path-less router serving the same host, or Traefik
    // hands `/api` to the whole-host router and the PathPrefix (and its stripprefix
    // middleware) never fire.
    ...(sig.pathPrefix
      ? [
          `traefik.http.routers.${key}.priority=${
            PATH_PRIORITY_BASE + sig.pathPrefix.length
          }`,
        ]
      : []),
    // `${1}` is Go's capture reference in the replacement, and every `$` is DOUBLED for
    // the same reason the basic-auth hashes are: these labels are embedded in a
    // docker-compose YAML, which would otherwise interpolate `${1}` as an (empty)
    ...(redirectName
      ? [
          `traefik.http.middlewares.${redirectName}.redirectregex.regex=^https?://[^/]+(.*)`,
          `traefik.http.middlewares.${redirectName}.redirectregex.replacement=${`${sig.redirectTo}\${1}`.replace(
            /\$/g,
            "$$$$",
          )}`,
          `traefik.http.middlewares.${redirectName}.redirectregex.permanent=true`,
        ]
      : []),
    ...(stripName
      ? [
          `traefik.http.middlewares.${stripName}.stripprefix.prefixes=${sig.pathPrefix}`,
        ]
      : []),
    ...(middlewares.length
      ? [`traefik.http.routers.${key}.middlewares=${middlewares.join(",")}`]
      : []),
    ...(withApp ? [`traefik.http.routers.${key}.service=${key}`] : []),
    `traefik.http.services.${key}.loadbalancer.server.port=${sig.port}`,
  ];
}
