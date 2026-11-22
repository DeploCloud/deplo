"use client";

import {
  Layers,
  Network,
  Route,
  ShieldCheck,
  ShieldOff,
  Signpost,
  Star,
} from "lucide-react";

import { CloudflareIcon } from "@/components/shared/brand-icons";
import { Badge } from "@/components/ui/badge";
import { DocsLink } from "@/components/ui/docs-link";
import { SimpleTooltip } from "@/components/ui/tooltip";
import type { CertProvider, Domain } from "@/lib/types/domain";

/** The chips beside a domain's name: primary, redirect, port, how its HTTPS is served, middlewares and path. */
export function DomainBadges({
  domain,
  effectiveProvider,
  cloudflare,
}: {
  domain: Domain;
  effectiveProvider: CertProvider;
  cloudflare: boolean;
}) {
  const middlewares = domain.middlewares ?? [];
  const oneCloudflareChip = cloudflare && effectiveProvider === "cloudflare";
  return (
    <>
      {domain.primary && (
        <Badge variant="secondary" className="gap-1">
          <Star className="size-3" />
          Primary
        </Badge>
      )}
      {domain.redirectTo && (
        <SimpleTooltip
          content={`Answers a permanent redirect (301) to ${domain.redirectTo}. Edit ${domain.redirectTo} to change or remove the pair.`}
        >
          <Badge variant="outline" className="gap-1 font-mono">
            <Signpost className="size-3" />→ {domain.redirectTo}
          </Badge>
        </SimpleTooltip>
      )}
      {domain.port != null && (
        <Badge variant="outline" className="gap-1 font-mono">
          <Network className="size-3" />:{domain.port}
        </Badge>
      )}
      {domain.tunnel ? (
        <SimpleTooltip
          content={
            <>
              Cloudflare serves it, HTTPS included. To turn the tunnel off,
              remove the domain and add it again.{" "}
              <DocsLink topic="domains.automaticDnsTunnel" />
            </>
          }
        >
          <Badge
            variant="outline"
            className="gap-1 border-[#f38020]/40 bg-[#f38020]/15 text-[#f38020]"
          >
            <CloudflareIcon className="size-3" />
            Cloudflare Tunnel
          </Badge>
        </SimpleTooltip>
      ) : oneCloudflareChip ? (
        <Badge
          variant="outline"
          className="gap-1 border-[#f38020]/40 bg-[#f38020]/15 text-[#f38020]"
        >
          <CloudflareIcon className="size-3" />
          Cloudflare
        </Badge>
      ) : effectiveProvider === "none" ? (
        <Badge variant="outline" className="gap-1">
          <ShieldOff className="size-3 text-muted-foreground" />
          HTTP
        </Badge>
      ) : (
        <Badge variant="outline" className="gap-1">
          <ShieldCheck className="size-3 text-success" />
          {effectiveProvider === "cloudflare"
            ? "Cloudflare"
            : effectiveProvider === "custom"
              ? "Server certificate"
              : "Let's Encrypt"}
        </Badge>
      )}
      {middlewares.length > 0 && (
        <SimpleTooltip content={middlewares.join(", ")}>
          <Badge variant="outline" className="gap-1">
            <Layers className="size-3" />
            {middlewares.length === 1
              ? middlewares[0]
              : `${middlewares.length} middlewares`}
          </Badge>
        </SimpleTooltip>
      )}
      {domain.pathPrefix && (
        <SimpleTooltip
          content={
            domain.stripPrefix
              ? `path ${domain.pathPrefix} (stripped)`
              : `path ${domain.pathPrefix}`
          }
        >
          <Badge variant="outline" className="gap-1 font-mono">
            <Route className="size-3" />
            {domain.pathPrefix}
          </Badge>
        </SimpleTooltip>
      )}
      {cloudflare && !oneCloudflareChip && !domain.tunnel && (
        <Badge
          variant="outline"
          className="gap-1 border-[#f38020]/40 bg-[#f38020]/15 text-[#f38020]"
        >
          <CloudflareIcon className="size-3" />
          Cloudflare DNS
        </Badge>
      )}
    </>
  );
}
