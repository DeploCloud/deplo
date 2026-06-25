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
 *     would collide between projects; Compose's project-prefixed names are safe
 *     and services still reach each other by service name on the shared network.
 *
 * The env the compose interpolates (`${VAR}`) is supplied to `docker compose`
 * via an `--env-file`, not baked in here.
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
  projectId: string;
  /**
   * The routed domains — one Traefik router each, to the route's named compose
   * service. The SOLE routing source (from the `domains` table). Empty ⇒ the
   * stack is built and run but NO routers are emitted (the project is unrouted
   * until a domain is added).
   */
  domainRoutes: ComposeDomainRoute[];
  /**
   * Absolute host directory holding this project's mount files. Compose
   * bind-mounts that reference `./<x>` (the project-files convention) are
   * rewritten to `<filesDir>/<x>` so each project's config files stay isolated.
   */
  filesDir?: string;
}

type Service = Record<string, unknown>;
type ComposeDoc = {
  services?: Record<string, Service>;
  networks?: Record<string, unknown>;
  version?: unknown;
  [k: string]: unknown;
};

/** First published container port of a service, if any (`"8080:80"` -> 80, `8080` -> 8080). */
function publishedPort(svc: Service): number | null {
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
export function detectDefaultService(
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
  return detectExpose(services as Record<string, Service>);
}

/** Pick the service Traefik should route to when the template did not say. */
function detectExpose(
  services: Record<string, Service>,
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
function deploLabels(projectId: string, slug: string): string[] {
  return ["deplo.managed=true", `deplo.project=${projectId}`, `deplo.slug=${slug}`];
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
}): string[] {
  const { router, domains, port, pathPrefix, stripPrefix } = opts;
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
  });
}

/**
 * Merge new label strings into a service's existing `labels`, dropping any
 * existing entry whose `KEY` collides (so re-deploys don't accumulate stale
 * routing/tracking labels). Compose accepts list OR map form; we normalise the
 * map form to a list before merging.
 */
function mergeLabels(svc: Service, add: string[]): void {
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
function rewriteServiceVolumes(svc: Service, filesDir: string): void {
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
function serviceNetworks(svc: Service): string[] {
  const n = svc.networks;
  if (Array.isArray(n)) return n.map(String);
  if (n && typeof n === "object") return Object.keys(n);
  return [];
}

export function buildComposeStack(input: ComposeStackInput): string {
  const { compose, name, slug, projectId, domainRoutes } = input;

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
  const tracking = deploLabels(projectId, slug);
  for (const svc of Object.values(services)) {
    if (svc && typeof svc === "object") {
      delete (svc as Service).container_name;
      if (input.filesDir) rewriteServiceVolumes(svc as Service, input.filesDir);
      mergeLabels(svc as Service, tracking);
    }
  }

  // Resolve a service's container port from the compose doc. Read BEFORE any
  // service is wired (wiring leaves `ports` intact, but read up front anyway so
  // the port source is unambiguous). A route without an explicit port falls back
  // to this.
  const portOf = (service: string): number => {
    const p = publishedPort(services[service] as Service);
    return p ?? 80; // conventional web port when the service declares none
  };

  // Services we've already joined to the network, so a service routed on two
  // hosts/ports is only network-wired once.
  const wired = new Set<string>();
  // Join a service to the deplo network (on top of its own networks) so Traefik
  // can reach it and inter-service DNS keeps working. Traefik fronts the routed
  // port over this network purely via the labels below — host publishing is
  // orthogonal to routing, so the service's own `ports:` are LEFT INTACT: a
  // user who publishes a port (a TCP game server, a database, an admin port)
  // keeps it reachable at that host port, AND still gets the HTTP router labels.
  // Idempotent per service.
  const wireService = (service: string): void => {
    if (wired.has(service)) return;
    const target = services[service] as Service | undefined;
    if (!target) return;
    const existing = serviceNetworks(target);
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
    wireService(service);
    const port = route.port ?? portOf(service);
    const keySeed = `${name}-${service}-${route.name}${route.pathPrefix}`;
    mergeLabels(
      services[service] as Service,
      traefikLabels({
        router: keySeed.replace(/[^a-zA-Z0-9_-]/g, "-"),
        domains: [route.name],
        port,
        pathPrefix: route.pathPrefix,
        stripPrefix: route.stripPrefix,
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
