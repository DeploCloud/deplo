import "server-only";

import yaml from "js-yaml";

import { certResolver } from "./domains";
import { traefikRouterLabels } from "./routing";

/**
 * Turn a raw template/user docker-compose file into a Deplo-deployable stack.
 *
 * Template compose files (and pasted ones) describe a plain multi-service app
 * with no awareness of Deplo's reverse proxy. To run them on a shared host we:
 *
 *  1. Attach the exposed service to the external `deplo` network (where Traefik
 *     lives) *in addition to* whatever networks it already used, so inter-service
 *     DNS keeps working and Traefik can reach it.
 *  2. Add Traefik routing labels on that service for the generated domain.
 *  3. Leave the service's published host `ports:` intact. Traefik fronts the
 *     routed port over the `deplo` network purely via the labels in (2), so HTTP
 *     routing works regardless of host publishing; a user who publishes a port
 *     (a TCP game server, a database, an admin port) keeps it reachable at that
 *     host port. (Two stacks that pin the SAME fixed host port will collide at
 *     `compose up` — that's the user's explicit mapping, surfaced loudly rather
 *     than silently dropped.)
 *  4. Strip `container_name` everywhere  it is globally unique on the host and
 *     would collide between services; Compose's project-prefixed names are safe
 *     and services still reach each other by service name on the shared network.
 *  5. Inject the project's settings env vars into EVERY service's `environment:`
 *     as bare `- KEY` pass-through entries (the value comes from the env-file),
 *     so a var added in project settings reaches the containers without the user
 *     also hand-writing it into the compose — the env-var analogue of the auto
 *     domain labels in (2). A key the service already declares (in any form) is
 *     never overridden.
 *
 * The env the compose interpolates (`${VAR}`) is supplied to `docker compose`
 * via an `--env-file`, not baked in here. The injected pass-through keys read
 * their VALUES from that same env-file at `compose up`, so no secret value ever
 * lands in the rendered YAML, the "View full compose" preview, or the on-disk
 * stack file — only the var NAMES appear.
 */

const NETWORK = "deplo";

/**
 * One routed hostname for a compose stack — the SOLE source of compose routing
 * (the `domains` table is authoritative; there is no separate `exposes`). Each
 * becomes exactly one Traefik router → its named compose `service`, on `port`
 * (the service's compose-declared port when null), optionally path-scoped. A
 * route MUST name a service it can wire (a compose domain always does — addDomain
 * requires it); a route whose service is null or absent from the stack is skipped.
 */
export interface ComposeDomainRoute {
  /** The hostname this router answers on. */
  name: string;
  /** Compose service to route to. Null ⇒ unroutable (skipped — compose domains
   * always carry a service). */
  service: string | null;
  /** Container port; null ⇒ the chosen service's compose-declared port. */
  port: number | null;
  /** Path prefix to match (empty ⇒ whole host). */
  pathPrefix: string;
  /** Strip `pathPrefix` before forwarding. */
  stripPrefix: boolean;
}

export interface ComposeStackInput {
  compose: string;
  /** Router/service name + label namespace, e.g. `deplo-<slug>`. */
  name: string;
  slug: string;
  appId: string;
  /**
   * The routed domains — one Traefik router each, to the route's named compose
   * service. The SOLE routing source (from the `domains` table). Empty ⇒ the
   * stack is built and run but NO routers are emitted (the project is unrouted
   * until a domain is added).
   */
  domainRoutes: ComposeDomainRoute[];
  /**
   * Absolute host directory holding this project's mount files. Compose
   * bind-mounts that reference `./<x>` (the app-files convention) are
   * rewritten to `<filesDir>/<x>` so each project's config files stay isolated.
   */
  filesDir?: string;
  /**
   * App-wide HTTP Basic Auth htpasswd users (`user:$apr1$…,user2:…`, raw
   * single-`$`). When non-empty, a generated `basicauth` middleware is defined
   * and prepended to EVERY router's chain so all of the stack's routed hostnames
   * are gated. Empty/absent ⇒ no middleware (byte-identical to a stack without
   * basic auth). The `$`→`$$` compose escaping happens inside the router grammar.
   */
  basicAuthUsers?: string;
  /**
   * The NAMES of the project's settings env vars (production target), injected
   * into every service's `environment:` as bare `- KEY` pass-through entries so
   * they reach the containers without the user hand-writing them into the
   * compose — the env-var analogue of the auto domain labels. Only keys are
   * passed (never values): the value comes from the `--env-file` at `compose up`,
   * so no secret lands in the rendered YAML / preview / on-disk stack. A key the
   * service ALREADY declares (in any form) is left as-is. Empty/absent ⇒ no
   * `environment:` change (byte-identical to a stack without injected env).
   */
  envKeys?: string[];
}

type App = Record<string, unknown>;
type ComposeDoc = {
  services?: Record<string, App>;
  networks?: Record<string, unknown>;
  version?: unknown;
  [k: string]: unknown;
};

/** First published container port of a service, if any (`"8080:80"` -> 80, `8080` -> 8080). */
function publishedPort(svc: App): number | null {
  const ports = svc.ports;
  if (!Array.isArray(ports) || ports.length === 0) return null;
  const first = ports[0];
  if (typeof first === "number") return first;
  if (typeof first === "string") {
    const parts = first.split(":");
    const target = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    const n = Number(target.replace(/\/.*$/, "").trim());
    return Number.isFinite(n) ? n : null;
  }
  if (first && typeof first === "object") {
    const t = (first as Record<string, unknown>).target;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Pick a default `{service, port}` to seed a compose project's FIRST domain when
 * neither the template nor the user named one. Parses the compose YAML and runs
 * the same heuristic the renderer used to: a service that publishes a port, else
 * the first service on a conventional web port. Null when the compose is
 * unparseable or has no services. Used at project creation only — after that the
 * `domains` table (each row's `service`) is authoritative.
 */
export function detectDefaultApp(
  compose: string | null,
): { service: string; port: number } | null {
  if (!compose || !compose.trim()) return null;
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return null;
  }
  const services = doc.services;
  if (!services || typeof services !== "object") return null;
  return detectExpose(services as Record<string, App>);
}

/** Pick the service Traefik should route to when the template did not say. */
function detectExpose(
  services: Record<string, App>,
): { service: string; port: number } | null {
  const names = Object.keys(services);
  if (names.length === 0) return null;
  // Prefer a service that publishes a port.
  for (const name of names) {
    const p = publishedPort(services[name]);
    if (p) return { service: name, port: p };
  }
  // Otherwise the first service on a conventional web port.
  return { service: names[0], port: 80 };
}

/** Labels that mark a container as Deplo-owned. Applied to EVERY service so the
 * whole stack is discoverable by `label=deplo.project=<id>` / `deplo.slug=<slug>`
 * — container counts, the console, health waits and teardown all rely on this. */
function deploLabels(appId: string, slug: string): string[] {
  return ["deplo.managed=true", `deplo.project=${appId}`, `deplo.slug=${slug}`];
}

/**
 * Traefik routing labels for one exposed service, via the shared routing module
 * (compose-stack flavour: a fixed per-route key, the deplo `docker.network`
 * pin, and an always-explicit `.service` label). `router` is the unique
 * router/service key — a service exposed on several hosts/ports gets one set per
 * route, so the key must differ; `enable`+`network` are emitted once via the
 * first route's labels but are harmless if repeated.
 */
function traefikLabels(opts: {
  router: string;
  domains: string[];
  port: number;
  /** Optional path prefix this router matches (empty ⇒ whole host). */
  pathPrefix?: string;
  /** Strip the path prefix before forwarding (ignored without a path). */
  stripPrefix?: boolean;
  /** App-wide Basic Auth: a generated `basicauth` middleware (defined once
   * and prepended to this router's chain). Absent ⇒ no auth. */
  basicAuth?: { name: string; users: string };
}): string[] {
  const { router, domains, port, pathPrefix, stripPrefix, basicAuth } = opts;
  // One router named `router`, serving every host in `domains` on `port` (a
  // single OR-rule). Default grouping with all hosts at the default port folds
  // them into the one `baseKey` router — `alwaysService` forces the explicit
  // `.service` label this path has always emitted. A path/strip, when set,
  // threads through to the shared grammar (PathPrefix + stripprefix middleware);
  // omitted ⇒ byte-identical to the long-standing host-only output.
  return traefikRouterLabels({
    baseKey: router,
    routes: domains.map((name) => ({ name, port: null, pathPrefix, stripPrefix })),
    defaultPort: port,
    certResolver: certResolver(),
    dockerNetwork: NETWORK,
    alwaysService: true,
    ...(basicAuth ? { basicAuth } : {}),
  });
}

/**
 * Merge new label strings into a service's existing `labels`, dropping any
 * existing entry whose `KEY` collides (so re-deploys don't accumulate stale
 * routing/tracking labels). Compose accepts list OR map form; we normalise the
 * map form to a list before merging.
 */
function mergeLabels(svc: App, add: string[]): void {
  const keyOf = (l: string): string => l.split("=")[0];
  const incoming = new Set(add.map(keyOf));
  const existing: string[] = [];
  if (Array.isArray(svc.labels)) {
    for (const l of svc.labels) {
      if (typeof l === "string" && !incoming.has(keyOf(l))) existing.push(l);
    }
  } else if (svc.labels && typeof svc.labels === "object") {
    for (const [k, v] of Object.entries(svc.labels as Record<string, unknown>)) {
      if (!incoming.has(k)) existing.push(`${k}=${String(v)}`);
    }
  }
  svc.labels = [...existing, ...add];
}

/**
 * Inject the project's settings env-var KEYS into a service's `environment:` as
 * bare `- KEY` pass-through entries (the value comes from the `--env-file` at
 * `compose up`), so a var added in settings reaches the container without the
 * user hand-writing it — the env analogue of `mergeLabels`. We NORMALISE to list
 * form (compose accepts list OR map): an existing map is flattened to `KEY=value`
 * / `KEY` strings, then the missing keys are appended as bare names.
 *
 * A key the service ALREADY declares wins and is never re-added — neither its
 * value (`KEY=value`, `KEY: value`) nor a hand-written pass-through (`- KEY`) is
 * touched, so the user's compose-authored env always overrides the injected one
 * (the same "existing wins" precedence the settings→single-image path already
 * has, where a project var can't clobber a value baked into the image's compose).
 * Empty `keys` ⇒ the service is left exactly as-is (no `environment:` key is
 * created on a service that had none), keeping the output byte-identical.
 */
function mergeEnvironment(svc: App, keys: string[]): void {
  if (keys.length === 0) return;
  // The bare NAME a list entry (`KEY` or `KEY=value`) or a map key declares.
  const nameOf = (entry: string): string => entry.split("=")[0].trim();
  const existing: string[] = [];
  const declared = new Set<string>();
  const env = svc.environment;
  if (Array.isArray(env)) {
    for (const e of env) {
      if (typeof e === "string") {
        existing.push(e);
        declared.add(nameOf(e));
      }
    }
  } else if (env && typeof env === "object") {
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      // A null map value (`KEY:`) is compose's own pass-through form — emit the
      // bare key, not `KEY=null`, so it keeps reading from the env-file.
      existing.push(v === null || v === undefined ? k : `${k}=${String(v)}`);
      declared.add(k);
    }
  }
  const added = keys.filter((k) => !declared.has(k));
  // Nothing new to inject ⇒ leave the service untouched (don't rewrite a map to
  // a list, which would needlessly churn the YAML and restart the container on a
  // reroute). Only when there's something to add do we normalise to list form.
  if (added.length === 0) return;
  svc.environment = [...existing, ...added];
}

/**
 * Rewrite a project-relative `./<x>` bind-mount source to the project's isolated
 * files dir. `./config.toml` → `<filesDir>/config.toml`, `./folder/x` →
 * `<filesDir>/folder/x`, bare `.`/`./` → `<filesDir>`. A `../` source escapes the
 * sandbox and is intentionally NOT rewritten — it falls through unchanged and is
 * caught by the host-bind permission gate (see `isHostBindSource`). Absolute
 * (`/srv/x`) and named (`vol`) sources pass through untouched.
 */
function rewriteMountSource(source: string, filesDir: string): string {
  if (source.includes("..")) return source; // escape — leave for the gate to block
  const m = source.match(/^\.\/?(.*)$/);
  if (!m) return source;
  const rel = m[1].replace(/^\/+/, "").replace(/\/+$/, "");
  return rel ? `${filesDir}/${rel}` : filesDir;
}

/** Point every `../files/...` bind mount at the per-project files directory. */
function rewriteAppVolumes(svc: App, filesDir: string): void {
  const vols = svc.volumes;
  if (!Array.isArray(vols)) return;
  svc.volumes = vols.map((v) => {
    if (typeof v === "string") {
      const idx = v.indexOf(":");
      if (idx <= 0) return v;
      const source = v.slice(0, idx);
      return `${rewriteMountSource(source, filesDir)}${v.slice(idx)}`;
    }
    if (v && typeof v === "object") {
      const rec = v as Record<string, unknown>;
      if (typeof rec.source === "string") {
        rec.source = rewriteMountSource(rec.source, filesDir);
      }
    }
    return v;
  });
}

/** Existing networks of a service as a string list (handles array/map/absent). */
function appNetworks(svc: App): string[] {
  const n = svc.networks;
  if (Array.isArray(n)) return n.map(String);
  if (n && typeof n === "object") return Object.keys(n);
  return [];
}

export function buildComposeStack(input: ComposeStackInput): string {
  const { compose, name, slug, appId, domainRoutes } = input;
  // App settings env-var NAMES injected into every service as bare `- KEY`
  // pass-throughs below (values stay in the env-file). Empty/absent ⇒ no env
  // change at all (byte-identical to a stack without injected env).
  const envKeys = input.envKeys ?? [];
  // One generated basicauth middleware for the whole project, prepended to every
  // router below so all routed hostnames are gated. Absent users ⇒ undefined, so
  // the routers render byte-identically to a stack without basic auth.
  const basicAuth = input.basicAuthUsers
    ? { name: `${name}-basicauth`, users: input.basicAuthUsers }
    : undefined;

  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch (e) {
    throw new Error(
      `Invalid docker-compose file: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!doc.services || typeof doc.services !== "object") {
    throw new Error("Compose file has no services to deploy");
  }

  // `version:` is obsolete in Compose v2 and only emits warnings.
  delete doc.version;

  const services = doc.services;

  // Strip globally-unique container names everywhere, point template file mounts
  // at this project's isolated files dir, and stamp Deplo tracking labels on
  // EVERY service so the whole stack (not just the routed ones) is discoverable
  // by label — otherwise sidecars/databases are invisible to the container
  // count, console, health wait and teardown.
  const tracking = deploLabels(appId, slug);
  for (const svc of Object.values(services)) {
    if (svc && typeof svc === "object") {
      delete (svc as App).container_name;
      if (input.filesDir) rewriteAppVolumes(svc as App, input.filesDir);
      mergeLabels(svc as App, tracking);
      // Inject the project's settings env vars as bare `- KEY` pass-throughs on
      // EVERY service (the value rides the env-file) — the env analogue of the
      // tracking/routing labels above. A key the service already declares wins.
      mergeEnvironment(svc as App, envKeys);
    }
  }

  // Resolve a service's container port from the compose doc. Read BEFORE any
  // service is wired (wiring leaves `ports` intact, but read up front anyway so
  // the port source is unambiguous). A route without an explicit port falls back
  // to this.
  const portOf = (service: string): number => {
    const p = publishedPort(services[service] as App);
    return p ?? 80; // conventional web port when the service declares none
  };

  // Apps we've already joined to the network, so a service routed on two
  // hosts/ports is only network-wired once.
  const wired = new Set<string>();
  // Join a service to the deplo network (on top of its own networks) so Traefik
  // can reach it and inter-service DNS keeps working. Traefik fronts the routed
  // port over this network purely via the labels below — host publishing is
  // orthogonal to routing, so the service's own `ports:` are LEFT INTACT: a
  // user who publishes a port (a TCP game server, a database, an admin port)
  // keeps it reachable at that host port, AND still gets the HTTP router labels.
  // Idempotent per service.
  const wireApp = (service: string): void => {
    if (wired.has(service)) return;
    const target = services[service] as App | undefined;
    if (!target) return;
    const existing = appNetworks(target);
    const base = existing.length ? existing : ["default"];
    target.networks = Array.from(new Set([...base, NETWORK]));
    wired.add(service);
  };

  // The `domains` table IS the routing: one Traefik router per routed domain,
  // each to its named compose service. A route with no service (or a service not
  // in the stack) can't be wired — skip it rather than emit a router pointing at
  // nothing. The router key is per-(host,service,path) so the generated
  // stripprefix middleware name (keyed off it in the routing grammar) is unique
  // and a path-scoped route coexists with a whole-host route via Traefik priority.
  for (const route of domainRoutes) {
    const service = route.service;
    if (!service || !services[service]) continue;
    wireApp(service);
    const port = route.port ?? portOf(service);
    const keySeed = `${name}-${service}-${route.name}${route.pathPrefix}`;
    mergeLabels(
      services[service] as App,
      traefikLabels({
        router: keySeed.replace(/[^a-zA-Z0-9_-]/g, "-"),
        domains: [route.name],
        port,
        pathPrefix: route.pathPrefix,
        stripPrefix: route.stripPrefix,
        ...(basicAuth ? { basicAuth } : {}),
      }),
    );
  }

  // Declare the external deplo network at the top level.
  const networks = (doc.networks && typeof doc.networks === "object"
    ? doc.networks
    : {}) as Record<string, unknown>;
  networks[NETWORK] = { external: true };
  doc.networks = networks;

  const body = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return `# Generated by Deplo  ${slug}\n${body}`;
}
