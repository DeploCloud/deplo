import "server-only";

import yaml from "js-yaml";

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

export interface ComposeStackInput {
  compose: string;
  /** Router/service name + label namespace, e.g. `deplo-<slug>`. */
  name: string;
  slug: string;
  projectId: string;
  /** Generated public hostname Traefik routes to this stack. */
  domain: string;
  /** Which service + container port to expose; auto-detected when null. */
  expose: { service: string; port: number } | null;
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

function traefikLabels(opts: {
  name: string;
  domain: string;
  port: number;
  projectId: string;
  slug: string;
}): string[] {
  const { name, domain, port, projectId, slug } = opts;
  return [
    "traefik.enable=true",
    `traefik.docker.network=${NETWORK}`,
    `traefik.http.routers.${name}.rule=Host(\`${domain}\`)`,
    `traefik.http.routers.${name}.entrypoints=websecure`,
    `traefik.http.routers.${name}.tls=true`,
    `traefik.http.routers.${name}.tls.certresolver=letsencrypt`,
    `traefik.http.services.${name}.loadbalancer.server.port=${port}`,
    "deplo.managed=true",
    `deplo.project=${projectId}`,
    `deplo.slug=${slug}`,
  ];
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
  const { compose, name, slug, projectId, domain } = input;

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
  const expose =
    (input.expose && services[input.expose.service] ? input.expose : null) ??
    detectExpose(services);
  if (!expose) throw new Error("Compose file has no services to deploy");

  // Strip globally-unique container names everywhere, and point template file
  // mounts at this project's isolated files directory.
  for (const svc of Object.values(services)) {
    if (svc && typeof svc === "object") {
      delete (svc as Service).container_name;
      if (input.filesDir) rewriteServiceVolumes(svc as Service, input.filesDir);
    }
  }

  const target = services[expose.service];
  // Join the exposed service to the deplo network on top of its own networks
  // (default to Compose's `default` when it declared none) so connectivity to
  // sibling services is preserved.
  const existing = serviceNetworks(target);
  const base = existing.length ? existing : ["default"];
  target.networks = Array.from(new Set([...base, NETWORK]));

  // Traefik fronts the exposed service; drop its published host ports.
  delete target.ports;

  // Attach routing labels (merge with any the template already declared).
  const labels = traefikLabels({ name, domain, port: expose.port, projectId, slug });
  const existingLabels = target.labels;
  if (Array.isArray(existingLabels)) {
    target.labels = [
      ...existingLabels.filter(
        (l) => typeof l === "string" && !l.startsWith("traefik."),
      ),
      ...labels,
    ];
  } else {
    target.labels = labels;
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
