"use client";

import { CloudflareIcon } from "@/components/shared/brand-icons";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";

/** Says Deplo makes this name's DNS record, and offers to serve it through a Cloudflare Tunnel. */
export function AutoDnsField({
  id,
  zone,
  tunnel,
  onTunnel,
}: {
  id: string;
  zone: string;
  tunnel: boolean;
  onTunnel: (on: boolean) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border border-[#f38020]/40 bg-[#f38020]/5 px-3 py-2">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <CloudflareIcon className="size-3.5 shrink-0 text-[#f38020]" />
        <span>
          Deplo creates the DNS record in{" "}
          <span className="font-mono text-foreground">{zone}</span>
        </span>
      </p>
      <div className="flex items-center justify-between gap-3">
        <FieldLabel
          htmlFor={id}
          className="cursor-pointer font-normal"
          info="Cloudflare reaches this server over a connection it opens: no port to open, HTTPS included. The first one restarts the server's proxy briefly."
        >
          Use Cloudflare Tunnel
        </FieldLabel>
        <Switch id={id} checked={tunnel} onCheckedChange={onTunnel} />
      </div>
    </div>
  );
}
