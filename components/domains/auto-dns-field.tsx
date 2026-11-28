"use client";

import { CloudflareIcon } from "@/components/shared/brand-icons";
import { DocsLink } from "@/components/ui/docs-link";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";

/** Says Deplo keeps this name's DNS record, and how Cloudflare serves it: straight, proxied or through a tunnel. */
export function AutoDnsField({
  id,
  zone,
  tunnel,
  onTunnel,
  proxied,
  onProxied,
}: {
  id: string;
  zone: string;
  tunnel: boolean;
  // Left out while the Tunnels experiment is off.
  onTunnel?: (on: boolean) => void;
  proxied: boolean;
  onProxied: (on: boolean) => void;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-[#f38020]/40 bg-[#f38020]/5 px-3 py-2">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CloudflareIcon className="size-3.5 shrink-0 text-[#f38020]" />
        <span>
          Deplo manages the DNS record in{" "}
          <span className="font-mono text-foreground">{zone}</span>.{" "}
          <DocsLink topic="domains.automaticDnsAdd" />
        </span>
      </p>
      {onTunnel && (
        <div className="flex items-center justify-between gap-3">
          <FieldLabel
            htmlFor={`${id}-tunnel`}
            className="cursor-pointer font-normal"
            info="Cloudflare reaches this server over a connection it opens: no port to open, HTTPS included. The first one restarts the server's proxy briefly."
            docs="domains.automaticDnsTunnel"
          >
            Use Cloudflare Tunnel
          </FieldLabel>
          <Switch
            id={`${id}-tunnel`}
            checked={tunnel}
            onCheckedChange={onTunnel}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <FieldLabel
          htmlFor={`${id}-proxied`}
          className="cursor-pointer font-normal"
          info="Visitors reach Cloudflare first, which hides this server's address. Off, the record points straight at the server."
          docs="domains.automaticDnsProxy"
        >
          Proxy through Cloudflare
        </FieldLabel>
        <Switch
          id={`${id}-proxied`}
          checked={tunnel || proxied}
          disabled={tunnel}
          onCheckedChange={onProxied}
        />
      </div>
    </div>
  );
}
