import { CloudflareIcon } from "@/components/shared/brand-icons";
import { CopyButton } from "@/components/shared/copy-button";

/**
 * Cloudflare answers for a hostname, so its A records are anycast and say nothing
 * about the origin. Shown wherever a DNS check comes back `cloudflare`.
 */
export function CloudflareNote({ serverIp }: { serverIp?: string | null }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-[#f38020]/30 bg-[#f38020]/10 px-3 py-2.5">
      <CloudflareIcon className="mt-0.5 size-5 shrink-0 text-[#f38020]" />
      <div className="min-w-0">
        <p className="text-sm font-medium">Cloudflare detected</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Cloudflare answers for it and serves its HTTPS, so there is nothing
          else to set up - but its records are Cloudflare&apos;s own, and Deplo
          cannot tell from DNS whether they still reach{" "}
          {serverIp ? (
            <span className="inline-flex items-baseline gap-1">
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                {serverIp}
              </code>
              <CopyButton value={serverIp} className="size-5" />
            </span>
          ) : (
            "this server"
          )}
          . Keep the A record pointed there with the proxy on.
        </p>
      </div>
    </div>
  );
}
