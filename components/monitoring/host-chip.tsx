// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import Link from "next/link";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The link to a server's own page - its agent, cleanup, teams and uninstall. */
export function ManageServerButton({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  return (
    <Button
      asChild
      variant="secondary"
      size="sm"
      className={cn("mr-2 shrink-0", className)}
    >
      <Link href={`/settings/servers/${id}`}>Manage</Link>
    </Button>
  );
}

/**
 * Which machine these numbers came from. A stack's monitoring reads the same
 * whichever host it runs on, so the page has to say which one - otherwise a
 * saturated chart sends you looking at the wrong server.
 */
export function HostChip({
  serverId,
  serverName,
  canManage,
}: {
  serverId: string;
  serverName: string;
  /** The server pages are instance-admin only, so the link is hidden without it
   *  rather than offered and answered with a 404. */
  canManage: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <Server className="size-4 shrink-0" />
        <span className="truncate">{serverName}</span>
      </span>
      {canManage && <ManageServerButton id={serverId} className="mr-0" />}
    </div>
  );
}
