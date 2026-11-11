import { TriangleAlert } from "lucide-react";

import { DocsLink } from "@/components/ui/docs-link";
import Link from "@/components/ui/link";

/** An App with no domain on Cloudflare: what a failover does to its address, and where to change that. */
export function ClusterAddressNote({ note }: { note: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning-wash-strong px-4 py-3 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <p>
        {note}{" "}
        <Link
          href="/settings/dns"
          className="font-medium underline underline-offset-2 hover:no-underline"
        >
          Connect Cloudflare
        </Link>{" "}
        <DocsLink topic="clusters.addresses" />
      </p>
    </div>
  );
}
