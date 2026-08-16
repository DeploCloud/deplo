import "server-only";

import yaml from "js-yaml";

import type { MountPropagation, ResourceLimits, VolumeMount } from "../types";
import { mountOptions } from "../apps/volume-model";
import { hostVolumeName } from "../utils";
import { certResolver } from "./domains";
import { traefikRouterLabels, hash6 } from "./routing";
import { mergeResourceLimits } from "./resources";
import {
  RESERVED_SHARED_NETWORK_NAMES,
  reservedNameMessage,
  sharedNetworkKeys,
} from "./compose-lint";

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
 *  6. Mount the app's Storage-settings volumes into the service each one names
 *     (`input.volumes`), adding the top-level `volumes:` entry a named volume
 *     needs. Persistent storage is therefore a first-class deplo setting for a
 *     compose stack too — nobody has to hand-edit YAML to keep data across
 *     deploys. Unlike (5) this is NOT applied to every service: one volume
 *     mounted into every container races on first-use seeding (whichever starts
 *     first fills the empty volume) and can shadow an image's own content.
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
  /** Absolute base URL this hostname permanently redirects to (`https://…`), or
   * empty/absent when it serves the app. Set for the redirecting half of a
   * `www` pair; the router still names a service (Traefik needs one) but the
   * generated redirect middleware answers before it is reached. */
  redirectTo?: string;
}

export interface ComposeStackInput {
  compose: string;
  /** Router/service name + label namespace, e.g. `deplo-<deployKey>`. */
  name: string;
  /**
   * The stack's DEPLOY KEY — what the named volumes and the `deplo.slug` label
   * are named after. The app slug for a production deploy (so the render stays
   * byte-identical), `<slug>__pr-<n>` for a pull request preview. See
   * [deploy-key](./deploy-key.ts).
   */
  deployKey: string;
  /**
   * Drop every service's published host `ports:`. Set for a pull request
   * preview and never for production: a host port cannot be shared, so an
   * inherited `ports:` would make the second preview of an app (or the first
   * one alongside production) fail to start.
   */
  stripPublishedPorts?: boolean;
  appId: string;
  /**
   * What the `deplo.project` label carries — the value the telemetry stream
   * buckets container stats by. Defaults to `appId`. A pull request preview
   * passes its OWN id, which is what keeps its containers out of the App's live
   * status, monitoring charts and console instance list; the owning app stays
   * discoverable on the host through the extra `deplo.app` label emitted only in
   * that case.
   */
  trackingId?: string;
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
   * App-wide HTTP Basic Auth htpasswd users (`user:$2b$…,user2:…`, raw
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
  /**
   * Per-app resource caps applied to EVERY service in the stack as `docker
   * compose up` keys (`mem_limit`/`cpus`/…), EXISTING-WINS: a service that sets
   * its own limit in the compose keeps it (like `envKeys`, the user's compose is
   * authoritative). Null/absent ⇒ no service is touched (byte-identical). A
   * multi-service stack has no host-level aggregate cgroup, so the app-level cap
   * is applied per service — see the Resources settings copy for compose stacks.
   */
  resources?: ResourceLimits | null;
  /**
   * The app's Storage-settings volumes, each mounted into the compose service it
   * names (`VolumeMount.service`; empty ⇒ the stack's default service — the one a
   * domain would route to). EXISTING-WINS per service: a service that already
   * mounts something at that container path in the user's own compose keeps its
   * mount untouched. A "named" volume also gets a top-level `volumes:` entry
   * pinning the per-app host name (`hostVolumeName`), the SAME name the
   * single-container renderer uses — so switching an app between sources keeps
   * its data, and the backup/move enumerators find it. Empty/absent ⇒ no volume
   * key is touched anywhere (byte-identical to a stack without them).
   *
   * A volume naming a service that is NOT in the compose throws: silently
   * mounting it somewhere else would strand data on the wrong container.
   */
  volumes?: VolumeMount[] | null;
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

/**
 * The container port ONE named service of a compose app answers on: the port it
 * publishes, else the conventional web port a route with no explicit port falls
 * back to (the same `portOf` the renderer uses when wiring Traefik). Null when
 * the compose is unparseable or has no such service.
 *
 * Exported for icon detection, which has to reach a running service directly and
 * therefore needs the same port Traefik was pointed at — read from the one place
 * that knows, rather than re-guessed.
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
  return publishedPort(svc as App) ?? 80;
}

/**
 * The service names a compose app is SUPPOSED to have containers for. The runtime
 * probe compares them against what the host actually has: a service with no
 * container at all (a `compose up` that never brought it back, a container that
 * was removed) is invisible to `docker ps`, so without this the app looks
 * perfectly healthy — every container that exists is running, because the broken
 * one is not there to count. Empty when the compose is unparseable or has none.
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
 * — container counts, the console, health waits and teardown all rely on this.
 * Exported for the database renderer (`database-compose.ts`), which stamps the
 * same labels with the database id so DB containers are equally discoverable. */
export function deploLabels(appId: string, slug: string): string[] {
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
  /** Absolute base URL this host permanently redirects to (the canonical half of
   * a `www` pair). Absent/empty ⇒ the router serves the service. */
  redirectTo?: string;
  /** App-wide Basic Auth: a generated `basicauth` middleware (defined once
   * and prepended to this router's chain). Absent ⇒ no auth. */
  basicAuth?: { name: string; users: string };
}): string[] {
  const { router, domains, port, pathPrefix, stripPrefix, redirectTo, basicAuth } =
    opts;
  // One router named `router`, serving every host in `domains` on `port` (a
  // single OR-rule). Default grouping with all hosts at the default port folds
  // them into the one `baseKey` router — `alwaysService` forces the explicit
  // `.service` label this path has always emitted. A path/strip, when set,
  // threads through to the shared grammar (PathPrefix + stripprefix middleware);
  // omitted ⇒ byte-identical to the long-standing host-only output.
  return traefikRouterLabels({
    baseKey: router,
    routes: domains.map((name) => ({
      name,
      port: null,
      pathPrefix,
      stripPrefix,
      redirectTo,
    })),
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
 * Stamp the Deplo tracking labels ONTO THE IMAGE a `build:` section produces
 * (`build.labels`), plus `deplo.service=<name>` so the agent can rank each
 * service's generations apart. Container labels (mergeLabels above) do not reach
 * the image config, which left compose-BUILT images unlabelled — invisible to the
 * cleanup's `unused_app_images` scope forever, so every rebuilt generation stayed
 * on disk. Services without `build:` are untouched (their images are pulled, not
 * ours to mark); the string shorthand `build: ./dir` is normalised to the object
 * form, which compose treats identically.
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
 * The IN-CONTAINER path a compose `volumes:` entry mounts at, for the
 * existing-wins check below. Handles every form compose accepts: the short
 * `src:dst[:mode]` string (dst is the second field), a bare `dst` anonymous
 * volume, and the long `{type, source, target}` object. Null when unreadable —
 * an entry we can't parse never blocks an injected mount (compose itself would
 * reject a duplicate target, which is the loud failure we'd want anyway).
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
 * Mount the app's Storage volumes into one service, appending a short-form
 * `- <source>:<target>[:ro[,rslave]]` per volume. EXISTING-WINS: a container path the
 * service already mounts in the user's own compose is skipped, so the authored
 * compose always beats the injected mount (the same precedence `mergeEnvironment`
 * and `mergeResourceLimits` use). Nothing to add ⇒ the service is left exactly
 * as-is, so a service with no `volumes:` key never grows an empty one.
 */
function mergeVolumes(svc: App, mounts: StackMount[]): void {
  if (mounts.length === 0) return;
  const existing: unknown[] = Array.isArray(svc.volumes) ? [...svc.volumes] : [];
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

/**
 * Mount the app's Storage-settings volumes into the stack and declare the named
 * ones at the top level.
 *
 * TARGET SERVICE: `volume.service` when set, else the stack's default service —
 * the same `detectExpose` heuristic a first domain uses, so on the overwhelmingly
 * common single-service compose the user configures NOTHING and the mount lands
 * where it must. A `service` naming something absent from the compose THROWS: the
 * alternative (quietly mounting it on another service) would leave, say, a
 * database writing to a fresh empty volume with the old data still on disk under
 * the previous service — data loss that looks like a successful deploy.
 *
 * SOURCE, per kind:
 *  - "named": the top-level alias, pinned to `hostVolumeName(deployKey, name)` —
 *    byte-for-byte the host name the single-container renderer uses, so an app
 *    that changes source keeps its data and `composeStackVolumeHostNames` (backup
 *    / server-move) enumerates it like any other stack volume.
 *  - "app": an absolute path inside the app's isolated files dir — the same
 *    sandbox the `./<x>` compose convention resolves to.
 *  - "host": the operator's absolute host path, verbatim (gated on the
 *    `canMountHostVolumes` grant back in `setAppVolumes`).
 */
function injectAppVolumes(
  doc: ComposeDoc,
  services: Record<string, App>,
  input: ComposeStackInput,
): void {
  const volumes = input.volumes ?? [];
  if (volumes.length === 0) return;

  const fallback = detectExpose(services)?.service ?? Object.keys(services)[0];
  // Existing top-level volume keys — ours must not collide with a key the user
  // already declared (that would silently re-point their volume at our mount).
  const topLevel = (doc.volumes && typeof doc.volumes === "object"
    ? doc.volumes
    : {}) as Record<string, unknown>;
  const takenKeys = new Set(Object.keys(topLevel));
  // Per-service mount lists, so a service is rewritten once with all of its
  // volumes (and the existing-wins check sees the authored compose, not our own
  // earlier injections).
  const byService = new Map<string, StackMount[]>();
  // Container paths each service ALREADY mounts in the authored compose, read
  // lazily once per service. Checked before a top-level alias is allocated, so an
  // existing-wins skip doesn't leave an orphan `volumes:` entry behind (compose
  // would create that empty volume and every backup would then carry it).
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
            `needs the app's files directory — internal error.`,
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
      // Host binds only — `propagation` is dropped for the other kinds on write.
      ...(v.propagation ? { propagation: v.propagation } : {}),
    });
    byService.set(svcName, list);
  }

  for (const [service, mounts] of byService) {
    mergeVolumes(services[service], mounts);
  }
  if (Object.keys(topLevel).length > 0) doc.volumes = topLevel;
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
  // `deplo.project` carries the TRACKING id (the app, or a preview's own id);
  // `deplo.app` is emitted only when the two differ, so a production stack's
  // labels are byte-identical to what they have always been.
  const tracking = [
    ...deploLabels(trackingId, deployKey),
    ...(trackingId === appId ? [] : [`deplo.app=${appId}`]),
  ];
  for (const [serviceName, svc] of Object.entries(services)) {
    if (svc && typeof svc === "object") {
      delete (svc as App).container_name;
      // A pull request preview publishes NOTHING on the host. Production's
      // `ports:` are left intact (see wireApp below) because a published port is
      // a deliberate choice — but a preview did not make that choice, it
      // inherited it, and a host port is a singleton: the second preview of the
      // same app, or the first alongside its own production stack, would fail to
      // start with "port is already allocated". Services still reach each other
      // over the `deplo` network and the outside world reaches them through
      // Traefik, which is how a preview is meant to be visited anyway.
      if (input.stripPublishedPorts) delete (svc as App).ports;
      if (input.filesDir) rewriteAppVolumes(svc as App, input.filesDir);
      mergeLabels(svc as App, tracking);
      // Built images get the same tracking as IMAGE labels (+ the service name)
      // so the cleanup's count-based retention can see and rank them.
      mergeBuildLabels(svc as App, serviceName, tracking);
      // Inject the project's settings env vars as bare `- KEY` pass-throughs on
      // EVERY service (the value rides the env-file) — the env analogue of the
      // tracking/routing labels above. A key the service already declares wins.
      mergeEnvironment(svc as App, envKeys);
      // Apply the app-level resource caps to EVERY service, existing-wins: a
      // service that already sets its own `mem_limit`/`cpus`/… keeps it. Null
      // resources ⇒ no-op (byte-identical).
      mergeResourceLimits(svc as App, input.resources);
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
        // `safe()` alone collapses `.`/`/` to `-`, so `api.example.com` and
        // `api-example.com` (or `/api/v1` and `/api-v1`) would produce the SAME
        // router key and mergeLabels would silently drop one router. Append an
        // injective hash of the full seed (same discriminator the single-image
        // renderer uses) so distinct routes never collide.
        router: `${keySeed.replace(/[^a-zA-Z0-9_-]/g, "-")}-${hash6(keySeed)}`,
        domains: [route.name],
        port,
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

  // THE choke point for the shared network: every service that ends up on it,
  // whether Deplo wired it for routing or the author attached it by hand.
  //
  // Two things are settled here rather than trusted. A container on that network
  // registers its SERVICE NAME as a DNS alias, and Docker round-robins a name two
  // containers both claim - so a service called `deplo` would collect the panel's
  // own traffic (Traefik forwards it to `http://deplo:3000`) and one called
  // `postgres` would collect the control plane's database connections, password
  // and all. And a hand-written `aliases:` list is a way to claim any OTHER name
  // on a network shared with every app on the host, which no app has a reason to
  // do: Deplo needs none, so none survive.
  //
  // The shared network is resolved by NAME, never by key: compose lets a network
  // be referenced under any key while pointing at another by `name:`, so
  // `{ sneaky: { external: true, name: deplo } }` is this network under an alias
  // of the author's choosing - and a rule that matched the key alone was one
  // rename away from decorative.
  const sharedKeys = sharedNetworkKeys(doc as { networks?: unknown });
  for (const [name, raw] of Object.entries(services)) {
    const svc = raw as App | undefined;
    if (!svc || typeof svc !== "object") continue;
    const nets = svc.networks;
    const joined = Array.isArray(nets)
      ? nets.map(String).filter((k) => sharedKeys.has(k))
      : nets && typeof nets === "object"
        ? Object.keys(nets).filter((k) => sharedKeys.has(k))
        : [];
    if (joined.length === 0) continue;
    if (RESERVED_SHARED_NETWORK_NAMES.has(name))
      throw new Error(reservedNameMessage(name));
    // Long form: keep the entry, drop whatever it carried. `null` is compose's
    // own "join with no options" and is what the short form means.
    if (!Array.isArray(nets) && nets && typeof nets === "object")
      for (const key of joined) (nets as Record<string, unknown>)[key] = null;
  }

  // Declare the external deplo network at the top level.
  const networks = (doc.networks && typeof doc.networks === "object"
    ? doc.networks
    : {}) as Record<string, unknown>;
  networks[NETWORK] = { external: true };
  doc.networks = networks;

  // Storage-settings volumes → the service each one names. Done last so the
  // existing-wins check sees the user's own `volumes:` exactly as authored.
  injectAppVolumes(doc, services, input);

  const body = yaml.dump(doc, { lineWidth: -1, noRefs: true });
  return `# Generated by Deplo  ${deployKey}\n${body}`;
}
