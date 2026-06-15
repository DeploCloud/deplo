/**
 * Traefik dynamic configuration helpers.
 *
 * Deplo routes every app/service through a single Traefik reverse proxy using
 * Docker provider labels. TLS is issued automatically via Let's Encrypt
 * (ACME, HTTP-01). This module renders the labels we attach to containers.
 */

export interface TraefikRouteOptions {
  /** Service/router name, e.g. project slug. */
  name: string;
  /** Public hostnames (first is primary). */
  domains: string[];
  /** Internal container port the app listens on. */
  port: number;
  /** Enable automatic HTTPS + http->https redirect. */
  tls?: boolean;
  /** Optional path prefix middleware. */
  pathPrefix?: string;
  /** ACME cert resolver name configured in Traefik. */
  certResolver?: string;
}

/** Render the Traefik label map for a container. */
export function traefikLabels(opts: TraefikRouteOptions): Record<string, string> {
  const {
    name,
    domains,
    port,
    tls = true,
    pathPrefix,
    certResolver = "letsencrypt",
  } = opts;
  const host = domains.map((d) => `Host(\`${d}\`)`).join(" || ");
  const rule = pathPrefix
    ? `(${host}) && PathPrefix(\`${pathPrefix}\`)`
    : host;

  const labels: Record<string, string> = {
    "traefik.enable": "true",
    [`traefik.http.routers.${name}.rule`]: rule,
    [`traefik.http.routers.${name}.entrypoints`]: tls ? "websecure" : "web",
    [`traefik.http.services.${name}.loadbalancer.server.port`]: String(port),
  };

  if (tls) {
    labels[`traefik.http.routers.${name}.tls`] = "true";
    labels[`traefik.http.routers.${name}.tls.certresolver`] = certResolver;
    // HTTP -> HTTPS redirect
    labels[`traefik.http.routers.${name}-web.rule`] = rule;
    labels[`traefik.http.routers.${name}-web.entrypoints`] = "web";
    labels[`traefik.http.routers.${name}-web.middlewares`] = "redirect-to-https";
  }

  return labels;
}

/** Render labels as a docker-compose `labels:` YAML block. */
export function traefikLabelsYaml(opts: TraefikRouteOptions, indent = 6): string {
  const pad = " ".repeat(indent);
  return Object.entries(traefikLabels(opts))
    .map(([k, v]) => `${pad}- "${k}=${v}"`)
    .join("\n");
}

/** The shared middleware definition Deplo installs once on the proxy. */
export const TRAEFIK_HTTPS_REDIRECT_MIDDLEWARE = `# Installed once on the Traefik proxy
# traefik.http.middlewares.redirect-to-https.redirectscheme.scheme=https
# traefik.http.middlewares.redirect-to-https.redirectscheme.permanent=true`;
