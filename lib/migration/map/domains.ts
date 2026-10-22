import { composeRoutePort } from "../../deploy/compose-lint/routing";
import type { CertProvider, DomainEntrypoint } from "../../types/domain";
import type { SourceDomain } from "../model";

import type { Mapped } from "./source-platform";

const THROWAWAY_HOST_RE =
  /(^|\.)(traefik\.me|sslip\.io|nip\.io|deplo\.site|localhost)$/i;

export function isThrowawayHost(host: string): boolean {
  return THROWAWAY_HOST_RE.test(host.trim().toLowerCase());
}

export interface MappedDomain {
  host: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
  generated: boolean;
}

export function mapDomains(
  domains: SourceDomain[] | null | undefined,
  opts: {
    isCompose: boolean;
    fallbackPort?: number | null;
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
    const internal = (d.internalPath ?? "").trim();
    if (internal && internal !== "/")
      notes.push(
        `${host} rewrites the path to ${internal} before the container sees it. Deplo forwards the path as it is (or strips the prefix), so the app now receives ${pathPrefix || "/"} - check that it serves that.`,
      );
    const custom = (d.customEntrypoint ?? "").trim();
    if (custom && custom !== "web" && custom !== "websecure")
      notes.push(
        `${host} answered on {panel}'s "${custom}" entrypoint. Deplo has only web and websecure, so it comes across on websecure - open that port on this app if it needs one.`,
      );
    const service = opts.isCompose ? d.serviceName?.trim() || null : null;
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
