export interface RouterRoute {
  name: string;
  port: number | null;
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  middlewares?: string[];
  pathPrefix?: string;
  stripPrefix?: boolean;
  redirectTo?: string;
}

export interface RouterLabelOptions {
  baseKey: string;
  routes: RouterRoute[];
  defaultPort: number;
  certResolver: string;
  dockerNetwork?: string;
  alwaysService?: boolean;
  perRouteKey?: (route: RouterRoute) => string;
  basicAuth?: { name: string; users: string };
}

const PATH_PRIORITY_BASE = 1_000_000;

export function traefikRouterLabels(opts: RouterLabelOptions): string[] {
  if (opts.routes.length === 0) return ["traefik.enable=false"];

  const labels: string[] = ["traefik.enable=true"];
  if (opts.dockerNetwork) {
    labels.push(`traefik.docker.network=${opts.dockerNetwork}`);
  }

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

  const groups = new Map<string, { sig: RouterSig; hosts: string[] }>();
  for (const r of routes) {
    const sig = resolveTls(r, opts);
    const id = sigId(sig);
    const g = groups.get(id) ?? { sig, hosts: [] };
    g.hosts.push(r.name);
    groups.set(id, g);
  }
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
  const ordered = [...groups.entries()].sort(([a, ga], [b, gb]) => {
    if (a === defaultId) return -1;
    if (b === defaultId) return 1;
    if (ga.sig.port !== gb.sig.port) return ga.sig.port - gb.sig.port;
    return a < b ? -1 : a > b ? 1 : 0;
  });
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

interface RouterSig {
  port: number;
  entrypoint: string;
  tls: boolean;
  certResolver: string;
  middlewares: string[];
  pathPrefix: string;
  stripPrefix: boolean;
  redirectTo: string;
}

function resolveTls(route: RouterRoute, opts: RouterLabelOptions): RouterSig {
  const port = route.port ?? opts.defaultPort;
  const tls = route.tls ?? true;
  const middlewares = (route.middlewares ?? [])
    .map((m) => m.trim())
    .filter(Boolean);
  const pathPrefix = normalizeRulePath(route.pathPrefix);
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

function normalizeRedirectTarget(input?: string): string {
  const t = (input ?? "").trim();
  if (!t) return "";
  if (!/^https?:\/\/[^\s/]+/i.test(t)) return "";
  return t.replace(/\/+$/, "");
}

function normalizeRulePath(input?: string): string {
  let p = (input ?? "").trim().replace(/`/g, "");
  if (!p) return "";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+$/, "");
  return p === "" ? "" : p;
}

function sigId(sig: RouterSig): string {
  return `${sig.port}|${sig.entrypoint}|${sig.tls ? 1 : 0}|${sig.certResolver}|${sig.middlewares.join(",")}|${sig.pathPrefix}|${sig.stripPrefix ? 1 : 0}|${sig.redirectTo}`;
}

function sigSuffix(sig: RouterSig, defaultResolver: string): string {
  const parts = [String(sig.port)];
  if (!sig.tls) parts.push("http");
  else {
    if (sig.entrypoint !== "websecure") parts.push(safe(sig.entrypoint));
    if (sig.certResolver === "") parts.push("owncert");
    else if (sig.certResolver !== defaultResolver)
      parts.push(safe(sig.certResolver));
  }
  if (sig.pathPrefix) {
    parts.push(
      "path",
      safe(sig.pathPrefix),
      hash6(`${sig.pathPrefix}|${sig.stripPrefix ? 1 : 0}`),
    );
    if (sig.stripPrefix) parts.push("strip");
  }
  if (sig.middlewares.length) parts.push("mw", ...sig.middlewares.map(safe));
  if (sig.redirectTo) parts.push("redirect", hash6(sig.redirectTo));
  return parts.join("-");
}

function safe(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function hash6(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

function routerBlock(
  key: string,
  hosts: string[],
  sig: RouterSig,
  withApp: boolean,
): string[] {
  const hostRule = hosts.map((d) => `Host(\`${d}\`)`).join(" || ");
  const rule = sig.pathPrefix
    ? `(${hostRule}) && PathPrefix(\`${sig.pathPrefix}\`)`
    : hostRule;
  const stripName = sig.stripPrefix ? `${key}-stripprefix` : null;
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
          ...(sig.certResolver
            ? [
                `traefik.http.routers.${key}.tls.certresolver=${sig.certResolver}`,
              ]
            : []),
        ]
      : []),
    ...(sig.pathPrefix
      ? [
          `traefik.http.routers.${key}.priority=${
            PATH_PRIORITY_BASE + sig.pathPrefix.length
          }`,
        ]
      : []),
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
