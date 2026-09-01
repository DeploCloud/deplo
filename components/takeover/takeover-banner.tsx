import Link from "next/link";
import { HardDriveDownload } from "lucide-react";

import { takeoverStatus } from "@/lib/data/takeover";
import { SOURCE_COPY } from "@/components/settings/migrations/sources";

/**
 * The old platform is stopped but still on the disk. The dashboard is usable
 * again by then, so this is the only thing left that remembers.
 */
export async function TakeoverBanner() {
  const status = await takeoverStatus();
  if (!status || (status.state !== "done" && status.state !== "removing"))
    return null;
  const name = SOURCE_COPY[status.platform].name;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2 text-sm">
      <HardDriveDownload className="size-4 shrink-0 text-warning" />
      <span className="min-w-0">
        {status.state === "removing"
          ? `${name} is being removed from this machine.`
          : `${name} is stopped but still on this machine, taking up disk.`}
      </span>
      {status.state === "done" && (
        <Link
          href="/takeover"
          className="font-medium underline underline-offset-4"
        >
          Remove it
        </Link>
      )}
    </div>
  );
}
