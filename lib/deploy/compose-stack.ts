import "server-only";

// https://deplo.build/docs/advanced/compose-apps

import yaml from "../yaml";

import type { MountPropagation, ResourceLimits, VolumeMount } from "../types";
import { mountOptions } from "../apps/volume-model";
import { hostVolumeName } from "../utils";
import { certResolver } from "./domains";
import { traefikRouterLabels, hash6 } from "./routing";
import { mergeResourceLimits } from "./resources";
import {
  declaredPort,
  keepAuthoredEnvText,
  isDeploNetwork,
  isReservedSharedName,
  reservedNameMessage,
  serviceClaimedNames,
  serviceReservedClaim,
  sharedNetworkKeys,
} from "./compose-lint";
import { INFRA_NETWORK } from "./network";

// The detection reads the AUTHORED compose and has to answer in the wizard too,
// so it lives in the client-safe module; this stays its address for the server.
export { detectDefaultApp } from "./compose-lint";

/**
 * Turn a raw template/user docker-compose file into a Deplo-deployable stack. (Two
 * stacks that pin the SAME fixed host port will collide at `compose up` - that's
 * the user's explicit mapping, surfaced loudly rather than silently dropped.) 4.
 */

/**
 * One routed hostname for a compose stack - the SOLE source of compose routing
 * (the `domains` table is authoritative; there is no separate `exposes`).
 */
export interface ComposeDomainRoute {
  /** The hostname this router answers on. */
  name: string;
  /** Compose service to route to. Null ⇒ unroutable (skipped - compose domains
   * always carry a service). */
  service: string | null;
  /** Container port; null ⇒ the chosen service's compose-declared port. */
  port: number | null;
  /**
   * The route's TLS triplet, already resolved from its stored row by
   * `domainTlsConfig`.
   */
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  /** Path prefix to match (empty ⇒ whole host). */
  pathPrefix: string;
  /** Strip `pathPrefix` before forwarding. */
  stripPrefix: boolean;
  /**
   * Absolute base URL this hostname permanently redirects to (`https://…`), or
   * empty/absent when it serves the app.
   */
  redirectTo?: string;
}

export interface ComposeStackInput {
  compose: string;
  /** Router/service name + label namespace, e.g. `deplo-<deployKey>`. */
  name: string;
  /**
   * The stack's DEPLOY KEY - what the named volumes and the `deplo.slug` label are
   * named after.
   */
  deployKey: string;
  /**
   * Drop every service's published host `ports:`.
   */
  stripPublishedPorts?: boolean;
  appId: string;
  /**
   * What the `deplo.project` label carries - the value the telemetry stream
   * buckets container stats by.
   */
  trackingId?: string;
  /**
   * The routed domains - one Traefik router each, to the route's named compose
   * service.
   */
  domainRoutes: ComposeDomainRoute[];
  /**
   * Absolute host directory holding this project's mount files. Compose
   * bind-mounts that reference `./<x>` (the app-files convention) are
   * rewritten to `<filesDir>/<x>` so each project's config files stay isolated.
   */
  filesDir?: string;
  /**
   * App-wide HTTP Basic Auth htpasswd users (`user:$2b$…,user2:…`, raw
   * single-`$`).
   */
  basicAuthUsers?: string;
  /**
   * The NAMES of the project's settings env vars (production target), injected
   * into every service's `environment:` as bare `- KEY` pass-through entries so
   * they reach the containers without the user hand-writing them into the compose -
   * the env-var analogue of the auto domain labels.
   */
  envKeys?: string[];
  /**
   * Per-app resource caps applied to EVERY service in the stack as `docker compose
   * up` keys (`mem_limit`/`cpus`/…), EXISTING-WINS: a service that sets its own
   * limit in the compose keeps it (like `envKeys`, the user's compose is
   * authoritative).
   */
  resources?: ResourceLimits | null;
  /**
   * The app's Storage-settings volumes, each mounted into the compose service it
   * names (`VolumeMount.service`; empty ⇒ the stack's default service - the one a
   * domain would route to).
   */
  volumes?: VolumeMount[] | null;
  /**
   * The Docker network this stack's routed services join - the app's Environment,
   * its team, or a preview's own. See `lib/deploy/network.ts`.
   */
  network: string;
  /** Where to say what the render silently dropped. Absent ⇒ nobody is told. */
  onWarn?: (message: string) => void;
}

type App = Record<string, unknown>;
type ComposeDoc = {
  services?: Record<string, App>;
  networks?: Record<string, unknown>;
  version?: unknown;
  [k: string]: unknown;
};

/**
 * `docker compose` interpolates `$VAR` in every value it reads, so a `$` in an
 * authored value reached the container gutted - or holding the AGENT HOST's own
 * variable. `$$` is its escape; apply to an already-encoded scalar.
 */
export function escapeComposeDollars(encoded: string): string {
  return encoded.replace(/\$/g, "$$$$");
}

/**
 * The container port ONE named service of a compose app answers on: the port it
 * publishes, else the conventional web port a route with no explicit port falls
 * back to (the same `portOf` the renderer uses when wiring Traefik).
 */
export function composeServicePort(
  compose: string | null,
  service: string,
): number | null {
  if (!compose || !compose.trim() || !service) return null;
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return null;
  }
  const svc = doc.services?.[service];
  if (!svc || typeof svc !== "object") return null;
  return declaredPort(svc) ?? 80;
}

/**
 * The service names a compose app is SUPPOSED to have containers for.
 */
export function composeServiceNames(compose: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const services = doc.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  return Object.keys(services as Record<string, unknown>);
}

/**
 * The env keys the AUTHORED compose sets itself. `mergeEnvironment` leaves those
 * alone, so they keep the compose's value whatever the app's variables say - which
 * the Environment tab has to state, or the setting looks applied.
 */
export function composeDeclaredEnvKeys(compose: string | null): string[] {
  if (!compose || !compose.trim()) return [];
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const svc of Object.values(doc.services ?? {})) {
    const env = (svc as App)?.environment;
    if (Array.isArray(env)) {
      for (const e of env) {
        // `KEY=value` sets it; a bare `KEY` is the pass-through Deplo itself writes.
        if (typeof e === "string" && e.includes("="))
          out.add(e.split("=")[0].trim());
      }
    } else if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env as Record<string, unknown>))
        if (v !== null && v !== undefined) out.add(k);
    }
  }
  return [...out];
}

/**
 * Labels that mark a container as Deplo-owned.
 */
export function deploLabels(appId: string, slug: string): string[] {
  return ["deplo.managed=true", `deplo.project=${appId}`, `deplo.slug=${slug}`];
}

/**
 * Traefik routing labels for one exposed service, via the shared routing module
 * (compose-stack flavour: a fixed per-route key, the `docker.network` pin, and an
 * always-explicit `.service` label).
 */
function traefikLabels(opts: {
  router: string;
  /** The stack's own network - what Traefik must route through. */
  network: string;
  domains: string[];
  port: number;
  /** The route's OWN TLS triplet (`domainTlsConfig` of its stored row). Absent
   *  ⇒ the shared default (websecure + the instance resolver), which is what
   *  every route here used to get whether or not it had a certificate. */
  entrypoint?: string;
  tls?: boolean;
  certResolver?: string;
  /** Optional path prefix this router matches (empty ⇒ whole host). */
  pathPrefix?: string;
  /** Strip the path prefix before forwarding (ignored without a path). */
  stripPrefix?: boolean;
  /** Absolute base URL this host permanently redirects to (the canonical half of
   * a `www` pair). Absent/empty ⇒ the router serves the service. */
  redirectTo?: string;
  /** App-wide Basic Auth: a generated `basicauth` middleware (defined once
   * and prepended to this router's chain). Absent ⇒ no auth. */
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

/**
 * Drop every user-authored `traefik.*` label from a service. Called before Deplo
 * injects its own domains-derived routers, so only those remain. Match is
 * case-insensitive because Docker lowercases label keys.
 */
function stripTraefikLabels(svc: App): void {
  const isTraefik = (key: string): boolean => /^traefik\./i.test(key.trim());
  if (Array.isArray(svc.labels)) {
    svc.labels = svc.labels.filter(
      (l) => !(typeof l === "string" && isTraefik(l.split("=")[0])),
    );
  } else if (svc.labels && typeof svc.labels === "object") {
    const kept: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(
      svc.labels as Record<string, unknown>,
    )) {
      if (!isTraefik(k)) kept[k] = v;
    }
    svc.labels = kept;
  }
}

/**
 * Merge new label strings into a service's existing `labels`, dropping any
 * existing entry whose `KEY` collides (so re-deploys don't accumulate stale
 * routing/tracking labels).
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
    for (const [k, v] of Object.entries(
      svc.labels as Record<string, unknown>,
    )) {
      if (!incoming.has(k)) existing.push(`${k}=${String(v)}`);
    }
  }
  svc.labels = [...existing, ...add];
}

/**
 * Stamp the Deplo tracking labels ONTO THE IMAGE a `build:` section produces
 * (`build.labels`), plus `deplo.service=<name>` so the agent can rank each
 * service's generations apart.
 */
function mergeBuildLabels(svc: App, service: string, tracking: string[]): void {
  const b = (svc as Record<string, unknown>).build;
  if (b === undefined || b === null) return;
  const build: Record<string, unknown> =
    typeof b === "string" ? { context: b } : (b as Record<string, unknown>);
  const add = [...tracking, `deplo.service=${service}`];
  const keyOf = (l: string): string => l.split("=")[0];
  const incoming = new Set(add.map(keyOf));
  const existing: string[] = [];
  const labels = build.labels;
  if (Array.isArray(labels)) {
    for (const l of labels) {
      if (typeof l === "string" && !incoming.has(keyOf(l))) existing.push(l);
    }
  } else if (labels && typeof labels === "object") {
    for (const [k, v] of Object.entries(labels as Record<string, unknown>)) {
      if (!incoming.has(k)) existing.push(`${k}=${String(v)}`);
    }
  }
  build.labels = [...existing, ...add];
  (svc as Record<string, unknown>).build = build;
}

/**
 * Inject the project's settings env-var KEYS into a service's `environment:` as
 * bare `- KEY` pass-through entries (the value comes from the `--env-file` at
 * `compose up`), so a var added in settings reaches the container without the user
 * hand-writing it - the env analogue of `mergeLabels`.
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
      // A null map value (`KEY:`) is compose's own pass-through form - emit the
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
 * The IN-CONTAINER path a compose `volumes:` entry mounts at, for the
 * existing-wins check below.
 */
function containerPathOf(entry: unknown): string | null {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    const target = parts.length > 1 ? parts[1] : parts[0];
    const t = target.trim().replace(/\/+$/, "");
    return t || null;
  }
  if (entry && typeof entry === "object") {
    const t = (entry as Record<string, unknown>).target;
    if (typeof t === "string") return t.trim().replace(/\/+$/, "") || null;
  }
  return null;
}

/** One injected mount line's parts, before {@link mountOptions} spells its tail. */
type StackMount = {
  source: string;
  target: string;
  readOnly: boolean;
  propagation?: MountPropagation;
};

/**
 * Mount the app's Storage volumes into one service, appending a short-form `-
 * <source>:<target>[:ro[,rslave]]` per volume.
 */
function mergeVolumes(svc: App, mounts: StackMount[]): void {
  if (mounts.length === 0) return;
  const existing: unknown[] = Array.isArray(svc.volumes)
    ? [...svc.volumes]
    : [];
  const declared = new Set(
    existing.map(containerPathOf).filter((p): p is string => p !== null),
  );
  const added = mounts
    .filter((m) => !declared.has(m.target.replace(/\/+$/, "")))
    .map((m) => `${m.source}:${m.target}${mountOptions(m)}`);
  if (added.length === 0) return;
  svc.volumes = [...existing, ...added];
}

/**
 * Rewrite a project-relative `./<x>` bind-mount source to the project's isolated
 * files dir.
 */
function rewriteMountSource(source: string, filesDir: string): string {
  if (source.includes("..")) return source; // escape - leave for the gate to block
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

/**
 * Where a Storage volume with no service named lands. Deliberately NOT
 * `detectDefaultApp`: that one learned to skip databases, and following it would
 * move an existing app's mount into another container on its next deploy.
 */
function defaultVolumeService(services: Record<string, App>): string {
  const names = Object.keys(services).filter((n) => !isReservedSharedName(n));
  const published = names.find((n) => {
    const ports = services[n]?.ports;
    return Array.isArray(ports) && ports.length > 0;
  });
  return published ?? names[0] ?? Object.keys(services)[0];
}

/**
 * Mount the app's Storage-settings volumes into the stack and declare the named
 * ones at the top level.
 */
function injectAppVolumes(
  doc: ComposeDoc,
  services: Record<string, App>,
  input: ComposeStackInput,
): void {
  const volumes = input.volumes ?? [];
  if (volumes.length === 0) return;

  const fallback = defaultVolumeService(services);
  // Existing top-level volume keys - ours must not collide with a key the user
  // already declared (that would silently re-point their volume at our mount).
  const topLevel = (
    doc.volumes && typeof doc.volumes === "object" ? doc.volumes : {}
  ) as Record<string, unknown>;
  const takenKeys = new Set(Object.keys(topLevel));
  // Per-service mount lists, so a service is rewritten once with all of its
  // volumes (and the existing-wins check sees the authored compose, not our own
  // earlier injections).
  const byService = new Map<string, StackMount[]>();
  // Container paths each service ALREADY mounts in the authored compose, read lazily
  // once per service.
  const declaredBySvc = new Map<string, Set<string>>();
  const declaredFor = (name: string): Set<string> => {
    let paths = declaredBySvc.get(name);
    if (!paths) {
      const vols = services[name].volumes;
      paths = new Set(
        (Array.isArray(vols) ? vols : [])
          .map(containerPathOf)
          .filter((p): p is string => p !== null),
      );
      declaredBySvc.set(name, paths);
    }
    return paths;
  };

  for (const v of volumes) {
    const svcName = (v.service ?? "").trim() || fallback;
    if (!svcName || !services[svcName]) {
      throw new Error(
        `Volume "${v.name || v.mountPath}" is set to mount into compose service ` +
          `"${svcName || "?"}", which this compose file does not define. Pick an ` +
          `existing service in Settings → Storage.`,
      );
    }
    const declared = declaredFor(svcName);
    const targetPath = v.mountPath.replace(/\/+$/, "");
    if (declared.has(targetPath)) continue; // the authored compose wins
    declared.add(targetPath);
    let source: string;
    if (v.type === "host") {
      source = (v.hostPath ?? "").trim();
    } else if (v.type === "app") {
      if (!input.filesDir) {
        throw new Error(
          `Volume "${v.name || v.mountPath}" mounts a file from this app, which ` +
            `needs the app's files directory - internal error.`,
        );
      }
      source = `${input.filesDir}/${(v.projectPath ?? "").replace(/^\.\/+/, "")}`;
    } else {
      // Named: a fresh top-level alias whose `name:` pins the per-app host
      // volume. Prefer the user-facing name; fall back to a suffixed alias when
      // the compose already declares that key.
      let key = v.name;
      for (let n = 2; takenKeys.has(key); n++) key = `${v.name}-${n}`;
      takenKeys.add(key);
      topLevel[key] = { name: hostVolumeName(input.deployKey, v.name) };
      source = key;
    }
    const list = byService.get(svcName) ?? [];
    list.push({
      source,
      target: v.mountPath,
      readOnly: Boolean(v.readOnly),
      // Host binds only - `propagation` is dropped for the other kinds on write.
      ...(v.propagation ? { propagation: v.propagation } : {}),
    });
    byService.set(svcName, list);
  }

  for (const [service, mounts] of byService) {
    mergeVolumes(services[service], mounts);
  }
  if (Object.keys(topLevel).length > 0) doc.volumes = topLevel;
}

/** The authored compose with its env values re-quoted. See `keepAuthoredEnvText`. */
function readComposeKeepingEnvText(compose: string): string {
  try {
    const doc = yaml.parseDocument(compose);
    if (doc.errors.length > 0) return compose;
    return keepAuthoredEnvText(doc) ? String(doc) : compose;
  } catch {
    return compose;
  }
}

/**
 * `network_mode:` takes a free-form string, and any value that is not a keyword is
 * a docker NETWORK NAME - so it joins a network with DNS while `networks:` stays
 * empty and every rule that reads that key sees nothing.
 *
 * Refused HERE and not only at the gate, because the value can be
 * `${VAR}` filled from the env-file at `compose up`: no check on the authored text
 * can see the name, and a secret-typed variable does not even display it.
 */
function assertNetworkModeIsNotANetwork(service: string, mode: unknown): void {
  if (typeof mode !== "string") return;
  const value = mode.trim();
  // `$$` is compose's ESCAPE for a literal dollar, so it interpolates nothing.
  // Every other `$` does - `$NET` without braces just as much as `${NET}`, which
  // is exactly what `escapeComposeDollars` in this file already says.
  if (/(^|[^$])\$(\$\$)*[^$]/.test(`${value} `)) {
    throw new Error(
      `\`network_mode\` on service \`${service}\` is filled in from a variable. ` +
        `Deplo cannot tell which network that names, so it is refused - write the ` +
        `value in the compose file.`,
    );
  }
  if (isDeploNetwork(value)) {
    throw new Error(
      `\`network_mode: ${value}\` on service \`${service}\` names a network Deplo ` +
        `manages. Join your own Environment's network instead - remove ` +
        `\`network_mode\` and the service is on it already.`,
    );
  }
}

export function buildComposeStack(input: ComposeStackInput): string {
  const { compose, name, deployKey, appId, domainRoutes } = input;
  const trackingId = input.trackingId ?? appId;
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
    doc = (yaml.load(readComposeKeepingEnvText(compose)) as ComposeDoc) ?? {};
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

  // Strip globally-unique container names everywhere, point template file mounts at
  // this project's isolated files dir, and stamp Deplo tracking labels on EVERY
  // service so the whole stack (not just the routed ones) is discoverable by label,
  // otherwise sidecars/databases are invisible to the container count, console,
  // health wait and teardown.
  const tracking = [
    ...deploLabels(trackingId, deployKey),
    ...(trackingId === appId ? [] : [`deplo.app=${appId}`]),
  ];
  for (const [serviceName, svc] of Object.entries(services)) {
    if (svc && typeof svc === "object") {
      assertNetworkModeIsNotANetwork(serviceName, (svc as App).network_mode);
      delete (svc as App).container_name;
      // A pull request preview publishes NOTHING on the host.
      if (input.stripPublishedPorts) delete (svc as App).ports;
      if (input.filesDir) rewriteAppVolumes(svc as App, input.filesDir);
      // The `domains` table is the ONLY routing source: drop any user-authored
      // `traefik.*` label before Deplo stamps its own, so a hand-written router
      // rule can't claim another team's hostname on the shared network.
      stripTraefikLabels(svc as App);
      mergeLabels(svc as App, tracking);
      // Built images get the same tracking as IMAGE labels (+ the service name)
      // so the cleanup's count-based retention can see and rank them.
      mergeBuildLabels(svc as App, serviceName, tracking);
      // Inject the project's settings env vars as bare `- KEY` pass-throughs on
      // EVERY service (the value rides the env-file) - the env analogue of the
      // tracking/routing labels above. A key the service already declares wins.
      mergeEnvironment(svc as App, envKeys);
      // Apply the app-level resource caps to EVERY service, existing-wins: a
      // service that already sets its own `mem_limit`/`cpus`/… keeps it. Null
      // resources ⇒ no-op (byte-identical).
      mergeResourceLimits(svc as App, input.resources);
    }
  }

  // Resolve a service's container port from the compose doc.
  const portOf = (service: string): number => {
    return declaredPort(services[service]) ?? 80; // conventional web port when the service declares none
  };

  // Apps we've already joined to the network, so a service routed on two
  // hosts/ports is only network-wired once.
  const wired = new Set<string>();
  // Join a service to the deplo network (on top of its own networks) so Traefik can
  // reach it and inter-service DNS keeps working.
  const wireApp = (service: string): boolean => {
    const target = services[service] as App | undefined;
    if (!target) return false;
    if (target.network_mode != null) return false;
    if (wired.has(service)) return true;
    const nets = target.networks;
    if (nets && typeof nets === "object" && !Array.isArray(nets)) {
      // Long form: ADD the key, never rebuild the block as a list. Flattening it
      // dropped the author's `aliases`/`ipv4_address` on their OWN private networks,
      // which are legitimate now that a stack is not on a shared network with anyone.
      const map = nets as Record<string, unknown>;
      if (!(INFRA_NETWORK in map)) map[INFRA_NETWORK] = null;
    } else {
      const existing = appNetworks(target);
      // A service that declared nothing goes on the Environment's network ALONE,
      // not `default` as well: compose only creates `<project>_default` when
      // something asks for it, and that network is one more per stack against the
      // host's address-pool ceiling for no reach the stack does not already have.
      target.networks = Array.from(new Set([...existing, INFRA_NETWORK]));
    }
    wired.add(service);
    return true;
  };

  // The `domains` table IS the routing: one Traefik router per routed domain, each to
  // its named compose service. A route with no service (or a service not in the
  // stack) can't be wired - skip it rather than emit a router pointing at nothing.
  for (const route of domainRoutes) {
    const service = route.service;
    if (!service || !services[service]) continue;
    // A row written before the domain layer refused these names: wiring it would
    // put the platform's own name on the shared network, and the throw below would
    // take the WHOLE stack down with it - deploy included. Skip the route instead.
    if (serviceReservedClaim(service, services[service])) continue;
    if (!wireApp(service)) {
      // `network_mode` takes a service off every network of its own, so Traefik has
      // nothing to forward to and the domain answers nothing. Said out loud: the
      // deploy used to go green with a dead hostname and no line anywhere.
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
        // `api-example.com` (or `/api/v1` and `/api-v1`) would produce the SAME router key
        // and mergeLabels would silently drop one router.
        router: `${keySeed.replace(/[^a-zA-Z0-9_-]/g, "-")}-${hash6(keySeed)}`,
        domains: [route.name],
        port,
        // The row's own choice, resolved by `domainTlsConfig` before it got
        // here. A route that terminates no TLS must land on `web`.
        entrypoint: route.entrypoint,
        tls: route.tls,
        certResolver: route.certResolver,
        pathPrefix: route.pathPrefix,
        stripPrefix: route.stripPrefix,
        // A `www` host of a compose app still needs a router pointing at a real
        // service (Traefik requires one), but its generated redirect middleware
        // answers 301 before the container is ever reached.
        redirectTo: route.redirectTo,
        ...(basicAuth ? { basicAuth } : {}),
      }),
    );
  }

  // EVERY service joins, not only the routed ones. A worker with no domain is still
  // the app: leaving it on the compose project's private `default` is what put it
  // out of reach of the very database its Environment owns, while the docs promised
  // the opposite. `wireApp` skips a `network_mode` service, which cannot have one.
  //
  // A service holding a RESERVED name is left off instead of refused: `postgres` is
  // an ordinary name for a stack's own database, and it was harmless as long as
  // nothing put it on the shared network. Joining it automatically and then throwing
  // would stop such a stack from rendering at all. An author who joins it BY HAND
  // still gets the refusal below.
  // A service holding a reserved name cannot go on the shared network, but it is
  // still part of THIS stack and the rest of it has to reach it. Since nothing asks
  // for `default` any more, leaving it off both networks split the stack in two:
  // `web` on the Environment's, `postgres` alone on the project's default, and the
  // lookup between them failing. So when one is present, every service also keeps a
  // private `default` - the one network compose creates for exactly this.
  const reserved = Object.keys(services).filter((name) =>
    serviceReservedClaim(name, services[name]),
  );
  // Networks the author marked `internal: true` - no route off the host. THAT is a
  // deliberate isolation, and the only thing that keeps a service off the
  // Environment's network. Naming your own networks is NOT: organising services
  // into frontend/backend is what every non-trivial compose file does, and reading
  // that as "leave me alone" cut most stacks off from their own database.
  const internalNetworks = new Set(
    Object.entries(
      doc.networks &&
        typeof doc.networks === "object" &&
        !Array.isArray(doc.networks)
        ? (doc.networks as Record<string, unknown>)
        : {},
    )
      .filter(
        ([, v]) =>
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          (v as Record<string, unknown>).internal === true,
      )
      .map(([k]) => k),
  );
  /** True when every network this service joins is one the author sealed off. */
  const onlyInternal = (name: string): boolean => {
    const nets = (services[name] as App | undefined)?.networks;
    const joined = Array.isArray(nets)
      ? nets.map(String)
      : nets && typeof nets === "object"
        ? Object.keys(nets)
        : ["default"]; // no `networks:` ⇒ compose puts it on `default`
    return joined.length > 0 && joined.every((k) => internalNetworks.has(k));
  };
  // Read before the `default` below is added, or the test would see Deplo's own edit.
  const sealedOff = new Map(
    Object.keys(services).map((name) => [name, onlyInternal(name)]),
  );
  for (const name of Object.keys(services)) {
    const svc = services[name] as App | undefined;
    if (reserved.length > 0 && svc && svc.network_mode == null) {
      const nets = svc.networks;
      if (Array.isArray(nets) || nets == null)
        svc.networks = Array.from(
          new Set([
            ...(Array.isArray(nets) ? nets.map(String) : []),
            "default",
          ]),
        );
      else if (typeof nets === "object" && !("default" in nets))
        (nets as Record<string, unknown>).default = null;
    }
    if (reserved.includes(name)) continue;
    // Sealed off on purpose (`internal: true` on every network it joins) ⇒ left
    // alone, since adding the Environment's network hands back the egress the
    // author removed. Everything else joins, own networks and all: they keep theirs
    // AND reach their Environment. A ROUTED service is wired above regardless, or
    // its domain would answer nothing.
    if (sealedOff.get(name)) continue;
    wireApp(name);
  }

  // THE choke point for this stack's own network: every service that ends up on it,
  // whether Deplo wired it for routing, the author attached it by hand, or the author
  // pointed a key at a network that is not theirs. Every such key COLLAPSES onto
  // `deplo`, so exactly one entry names this network and nothing joins it twice.
  const sharedKeys = sharedNetworkKeys(doc as { networks?: unknown });
  // A service that declares no `networks:` joins `default`, so a `default` aimed at a
  // network Deplo owns put the whole stack there with no key of its own to notice.
  const defaultIsShared = sharedKeys.has("default");
  for (const [name, raw] of Object.entries(services)) {
    const svc = raw as App | undefined;
    if (!svc || typeof svc !== "object") continue;
    const nets = svc.networks;
    const declared = Array.isArray(nets)
      ? nets.map(String)
      : nets && typeof nets === "object"
        ? Object.keys(nets)
        : null;
    const joined = (declared ?? (defaultIsShared ? ["default"] : [])).filter(
      (k) => sharedKeys.has(k),
    );
    if (joined.length === 0) continue;
    const claim = serviceReservedClaim(name, svc);
    if (claim) throw new Error(reservedNameMessage(claim));
    if (declared === null) {
      svc.networks = [INFRA_NETWORK];
    } else if (Array.isArray(nets)) {
      svc.networks = [
        ...new Set(
          nets.map(String).map((k) => (sharedKeys.has(k) ? INFRA_NETWORK : k)),
        ),
      ];
    } else {
      // Long form: the author's own networks keep their options; every shared key
      // becomes one option-less `deplo`. `null` is compose's own "join with no
      // options", and the aliases were never theirs to hand out here.
      const map = nets as Record<string, unknown>;
      for (const key of joined) delete map[key];
      map[INFRA_NETWORK] = null;
    }
  }

  // Declare the stack's network at the top level, under ONE key. `deplo` is stable for
  // every stack and for anything the author wrote by hand, while `name:` points it at
  // the Environment's own network. Every other key that resolved to a network Deplo
  // owns is gone: its services already moved onto this one, and two keys naming one
  // network is a container attached to it twice. Rewriting beats refusing - the same
  // YAML arrives from an import, and a copy-pasted `networks: [deplo]` must keep working.
  // A LIST or a scalar under `networks:` is not a map: writing the `deplo` key onto
  // an array made `yaml.dump` drop it, so the stack shipped with its own network
  // never declared. Compose refuses that, so it failed closed - but every rule
  // above had been skipped on the way there. Anything that is not a map is dropped.
  const authored = doc.networks;
  const networks = (
    authored && typeof authored === "object" && !Array.isArray(authored)
      ? authored
      : {}
  ) as Record<string, unknown>;
  for (const key of sharedKeys) if (key !== INFRA_NETWORK) delete networks[key];
  networks[INFRA_NETWORK] = { name: input.network, external: true };
  doc.networks = networks;

  // Storage-settings volumes → the service each one names. Done last so the
  // existing-wins check sees the user's own `volumes:` exactly as authored.
  injectAppVolumes(doc, services, input);

  const body = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return `# Generated by Deplo  ${deployKey}\n${body}`;
}

/**
 * The DNS names a RENDERED stack registers on the stack's own network: only the
 * services actually joined to it, since one on a private network of its own is
 * nobody's neighbour. Read from the render, not the authored compose, so it sees
 * the services Deplo itself wired for routing.
 */
export function stackNamesOnNetwork(renderedYaml: string): string[] {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(renderedYaml) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(doc.services ?? {})) {
    const nets = raw?.networks;
    const joined = Array.isArray(nets)
      ? nets.map(String)
      : nets && typeof nets === "object"
        ? Object.keys(nets)
        : [];
    if (!joined.includes(INFRA_NETWORK)) continue;
    for (const claimed of serviceClaimedNames(name, raw))
      out.add(claimed.toLowerCase());
  }
  return [...out];
}

/**
 * Point a rendered stack's network entries at `network`, whatever they named
 * before. A restore ships the stack file READ OFF THE HOST, which can still name
 * the network the app had before it moved - or one the cleanup has since
 * reclaimed, and then `compose up` fails with "declared as external, but could
 * not be found" AFTER the data is back and the stack is down.
 */
export function retargetStackNetwork(
  renderedYaml: string,
  network: string,
): string {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(renderedYaml) as ComposeDoc) ?? {};
  } catch {
    return renderedYaml;
  }
  const nets = doc.networks;
  if (!nets || typeof nets !== "object" || Array.isArray(nets))
    return renderedYaml;
  let touched = false;
  for (const [key, raw] of Object.entries(nets as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const named = typeof entry.name === "string" ? entry.name.trim() : "";
    if (key !== INFRA_NETWORK && !(named && isDeploNetwork(named))) continue;
    if (named === network) continue;
    (nets as Record<string, unknown>)[key] = {
      name: network,
      external: true,
    };
    touched = true;
  }
  if (!touched) return renderedYaml;
  return yaml.dump(doc, { lineWidth: -1, noRefs: true });
}

/**
 * The `environment:` values a compose file sets ITSELF, keyed by variable name.
 * What a cross-network check has to read on top of the resolved env: a stack that
 * hardcodes a neighbour's hostname in its own block never goes through the env
 * layer at all.
 */
export function composeEnvValues(compose: string): Record<string, string> {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const svc of Object.values(doc.services ?? {})) {
    const env = (svc as App)?.environment;
    if (Array.isArray(env)) {
      for (const e of env) {
        if (typeof e !== "string" || !e.includes("=")) continue;
        const at = e.indexOf("=");
        out[e.slice(0, at).trim()] = e.slice(at + 1).trim();
      }
    } else if (env && typeof env === "object") {
      for (const [k, v] of Object.entries(env as Record<string, unknown>))
        if (v != null) out[k] = String(v);
    }
  }
  return out;
}

/**
 * The DNS names an AUTHORED compose would put on the Environment's network, which
 * is not every service it declares. A name-clash guard has to ask this and not
 * `composeClaimedNames`, or it refuses a move over a `postgres` that never joins -
 * naming, in the refusal, a container that does not exist there.
 *
 * Conservative in the one direction that is safe: a service kept off here can still
 * be wired by a ROUTE, and the deploy's clash warning catches that case.
 */
export function composeNamesOnNetwork(compose: string): string[] {
  let doc: ComposeDoc;
  try {
    doc = (yaml.load(compose) as ComposeDoc) ?? {};
  } catch {
    return [];
  }
  const services = doc.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return [];
  const internal = new Set(
    Object.entries(
      doc.networks &&
        typeof doc.networks === "object" &&
        !Array.isArray(doc.networks)
        ? (doc.networks as Record<string, unknown>)
        : {},
    )
      .filter(
        ([, v]) =>
          v &&
          typeof v === "object" &&
          !Array.isArray(v) &&
          (v as Record<string, unknown>).internal === true,
      )
      .map(([k]) => k),
  );
  const out = new Set<string>();
  for (const [name, raw] of Object.entries(services)) {
    const svc = raw as App | undefined;
    if (!svc || typeof svc !== "object") continue;
    // Off the network for the same three reasons the renderer keeps them off.
    if (serviceReservedClaim(name, svc)) continue;
    if (svc.network_mode != null) continue;
    const nets = svc.networks;
    const joined = Array.isArray(nets)
      ? nets.map(String)
      : nets && typeof nets === "object"
        ? Object.keys(nets)
        : ["default"];
    if (joined.length > 0 && joined.every((k) => internal.has(k))) continue;
    for (const claimed of serviceClaimedNames(name, svc))
      out.add(claimed.toLowerCase());
  }
  return [...out];
}
