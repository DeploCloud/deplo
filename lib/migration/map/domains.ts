import { composeRoutePort } from "../../deploy/compose-lint/routing";
import type { CertProvider, DomainEntrypoint } from "../../types/domain";
import type { SourceDomain } from "../model";

import type { Mapped } from "./source-platform";

/**
 * Hostnames that only ever meant "the box this used to run on": Dokploy's
 * generated `traefik.me` names and the wildcard-DNS services that encode an IP.
 */
const THROWAWAY_HOST_RE = /(^|\.)(traefik\.me|sslip\.io|nip\.io|localhost)$/i;

export function isThrowawayHost(host: string): boolean {
  return THROWAWAY_HOST_RE.test(host.trim().toLowerCase());
}

export interface MappedDomain {
  /**
   * The hostname on the SOURCE. When {@link generated} is true this name does
   * NOT come across - it is kept only so the report can say what became what.
   */
  host: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
  /**
   * The source host was the other platform's own THROWAWAY address - a
   * `*.sslip.io` / `*.traefik.me` / `*.nip.io` name with its server's IP baked in.
   */
  generated: boolean;
}

/**
 * The domains worth importing, in Dokploy's own order (the first survivor becomes
 * Deplo's primary).
 */
export function mapDomains(
  domains: SourceDomain[] | null | undefined,
  opts: {
    isCompose: boolean;
    fallbackPort?: number | null;
    /** The stack's own YAML, so a route that names a service but no port can
     *  read the port off that service instead of arriving with none. */
    compose?: string | null;
  },
): Mapped<MappedDomain[]> {
  const notes: string[] = [];
  const out: MappedDomain[] = [];
  for (const d of domains ?? []) {
    const host = d.host?.trim().toLowerCase();
    if (!host) continue;
    if (d.domainType === "preview") continue;
    if (d.enabled === false) continue;

    let certProvider: CertProvider = "none";
    if (d.certificateType === "letsencrypt") certProvider = "letsencrypt";
    else if (d.certificateType === "custom")
      notes.push(
        `${host} uses a custom certificate resolver on {panel}. Imported without a certificate - pick one in Domains.`,
      );

    const path = (d.path ?? "/").trim();
    const pathPrefix = path === "/" ? "" : path;
    // Dokploy can rewrite the path on the way to the container.
    const internal = (d.internalPath ?? "").trim();
    if (internal && internal !== "/")
      notes.push(
        `${host} rewrites the path to ${internal} before the container sees it. Deplo forwards the path as it is (or strips the prefix), so the app now receives ${pathPrefix || "/"} - check that it serves that.`,
      );
    // Deplo has two entrypoints, web and websecure. A route on any other one
    // lands on websecure, and that has to be said rather than discovered.
    const custom = (d.customEntrypoint ?? "").trim();
    if (custom && custom !== "web" && custom !== "websecure")
      notes.push(
        `${host} answered on {panel}'s "${custom}" entrypoint. Deplo has only web and websecure, so it comes across on websecure - open that port on this app if it needs one.`,
      );
    const service = opts.isCompose ? d.serviceName?.trim() || null : null;
    // A one-click template that declares `SERVICE_FQDN_<NAME>` without the
    // `_<PORT>` spelling records no port at all, and a stack route with none used
    // to arrive empty - which is a 404 on the address the panel printed.
    const read =
      opts.isCompose && service
        ? composeRoutePort(opts.compose, service)
        : null;
    const port = d.port ?? opts.fallbackPort ?? read;
    if (opts.isCompose && d.port == null && opts.fallbackPort == null)
      notes.push(
        port == null
          ? `${host} has no container port set - Deplo needs one for a compose stack.`
          : `${host} carried no container port on {panel}, so Deplo routes it to ${service} on port ${port} - what that service publishes, or the usual web port. Change it under Domains if it answers somewhere else.`,
      );

    out.push({
      host,
      port,
      pathPrefix,
      stripPrefix: pathPrefix ? d.stripPath === true : false,
      certProvider,
      entrypoint:
        d.https === false && certProvider === "none" ? "web" : "websecure",
      service,
      generated: isThrowawayHost(host),
    });
  }
  return { value: out, notes };
}
