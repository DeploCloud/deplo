import Link from "@/components/ui/link";
import { Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

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

export function HostChip({
  serverId,
  serverName,
  canManage,
}: {
  serverId: string;
  serverName: string;
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
