import "server-only";

import yaml from "js-yaml";

import { certResolver } from "./domains";

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
 *  3. Strip the exposed service's published host ports  Traefik fronts it, and
 *     fixed host ports would collide between stacks on the same host.
 *  4. Strip `container_name` everywhere  it is globally unique on the host and
 *     would collide between projects; Compose's project-prefixed names are safe
 *     and services still reach each other by service name on the shared network.
 *
 * The env the compose interpolates (`${VAR}`) is supplied to `docker compose`
 * via an `--env-file`, not baked in here.
 */

const NETWORK = "deplo";

/** One publicly-routed service: its name, container port, and the hostname
 * Traefik routes to it. `host` falls back to the stack's primary domain. */
export interface StackExpose {
  service: string;
  port: number;
  host?: string;
}

export interface ComposeStackInput {
  compose: string;
  /** Router/service name + label namespace, e.g. `deplo-<slug>`. */
  name: string;
  slug: string;
  projectId: string;
  /**
   * Public hostnames Traefik routes to this stack, primary first. A route with
   * no explicit `host` answers on all of these (so secondary verified domains
   * route to the app instantly); `domains[0]` is the primary canonical host.
   */
  domains: string[];
  /** Which service + container port to expose; auto-detected when null. */
  expose: { service: string; port: number } | null;
  /**
   * Every service to route publicly, each on its own host. Multi-domain
   * templates (e.g. garage-with-ui) declare two. When empty, falls back to the
   * single `expose` (or auto-detection) on the primary domain.
   */
  exposes?: StackExpose[];
  /**
   * Absolute host directory holding this project's mount files. Template
   * bind-mounts that reference `../files/<x>` (Dokploy convention) are rewritten
   * to `<filesDir>/<x>` so each project's config files stay isolated.
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
 * Traefik routing labels for one exposed service. `router` is the unique
 * router/service key (a service exposed on several hosts/ports gets one set per
 * route, so the key must differ); `enable`+`network` are emitted once via the
 * first route's labels but are harmless if repeated.
 */
function traefikLabels(opts: {
  router: string;
  domains: string[];
  port: number;
}): string[] {
  const { router, domains, port } = opts;
  const rule = domains.map((d) => `Host(\`${d}\`)`).join(" || ");
  return [
    "traefik.enable=true",
    `traefik.docker.network=${NETWORK}`,
    `traefik.http.routers.${router}.rule=${rule}`,
    `traefik.http.routers.${router}.entrypoints=websecure`,
    `traefik.http.routers.${router}.tls=true`,
    `traefik.http.routers.${router}.tls.certresolver=${certResolver()}`,
    `traefik.http.routers.${router}.service=${router}`,
    `traefik.http.services.${router}.loadbalancer.server.port=${port}`,
  ];
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

/** Rewrite a `../files/<x>` bind-mount source to the project's files dir. */
function rewriteMountSource(source: string, filesDir: string): string {
  const m = source.match(/^(?:\.\.?\/)*files\/(.+)$/);
  return m ? `${filesDir}/${m[1]}` : source;
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
  const { compose, name, slug, projectId, domains } = input;

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

  // The list of services to route publicly. Prefer the explicit multi-expose
  // list (templates with several config.domains), fall back to the single
  // expose, then to auto-detection. Drop any that name a service not present.
  const requested =
    input.exposes && input.exposes.length
      ? input.exposes
      : input.expose
        ? [input.expose]
        : [];
  let routes: StackExpose[] = requested.filter((e) => services[e.service]);
  if (routes.length === 0) {
    const auto = detectExpose(services);
    if (!auto) throw new Error("Compose file has no services to deploy");
    routes = [auto];
  }

  // Strip globally-unique container names everywhere, point template file mounts
  // at this project's isolated files dir, and stamp Deplo tracking labels on
  // EVERY service so the whole stack (not just the exposed one) is discoverable
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

  // A single route reuses the stack name as its router key (stable, matches the
  // legacy single-service behaviour); multiple routes get a per-route suffix so
  // each Traefik router/service key is unique even on the same container.
  const single = routes.length === 1;
  const routerKey = (e: StackExpose): string =>
    single ? name : `${name}-${e.service}-${e.port}`.replace(/[^a-zA-Z0-9_-]/g, "-");

  // Hosts a route pins explicitly (multi-domain templates like garage-with-ui
  // route a specific service to a specific hostname). A no-host route falls back
  // to the project's domain list, but MUST NOT swallow another route's pinned
  // host — two routers answering on the same Host() collide nondeterministically.
  const pinned = new Set(
    routes.map((r) => r.host?.trim()).filter((h): h is string => Boolean(h)),
  );
  const fallback = domains.filter((d) => !pinned.has(d));
  // Only the FIRST no-host route may claim the shared fallback domains; a second
  // no-host route claiming them too would emit a duplicate Host() rule on a
  // different router → nondeterministic routing. Subsequent no-host routes get
  // nothing routable (their router is skipped), so multi-domain templates must
  // pin each service's host explicitly.
  let fallbackClaimed = false;
  // The host(s) a route serves: its own pin if set, else every project domain
  // not pinned elsewhere (so a primary switch / new verified domain routes here
  // with no redeploy). Guard against an empty rule with the primary domain.
  const hostsFor = (route: StackExpose): string[] => {
    const host = route.host?.trim();
    if (host) return [host];
    if (fallbackClaimed) return [];
    fallbackClaimed = true;
    return fallback.length ? fallback : domains.slice(0, 1);
  };

  // Services we've already joined to the network / stripped ports for, so a
  // service exposed on two ports is only network-wired once.
  const wired = new Set<string>();
  for (const route of routes) {
    const target = services[route.service];
    if (!target) continue;
    if (!wired.has(route.service)) {
      // Join the exposed service to the deplo network on top of its own networks
      // (default to Compose's `default` when it declared none) so connectivity
      // to sibling services is preserved, and drop its published host ports —
      // Traefik fronts it.
      const existing = serviceNetworks(target);
      const base = existing.length ? existing : ["default"];
      target.networks = Array.from(new Set([...base, NETWORK]));
      delete target.ports;
      wired.add(route.service);
    }
    // Each route adds its own router on its own host(s). A no-host route after
    // the first has no hosts left to claim — skip its router rather than emit an
    // empty rule. Labels merge over the tracking labels.
    const hosts = hostsFor(route);
    if (hosts.length === 0) continue;
    mergeLabels(
      target,
      traefikLabels({
        router: routerKey(route),
        domains: hosts,
        port: route.port,
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
