import Link from "@/components/ui/link";
import { ArrowLeft, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Bone } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

// Shared with the loading state, which passes bones for the parts that are data.
export function ServerDetailHeader({
  name,
  title,
  badges,
  action,
  ip,
}: {
  name: React.ReactNode;
  title?: string;
  badges: React.ReactNode;
  action: React.ReactNode;
  ip: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 h-8 text-muted-foreground"
        asChild
      >
        <Link href="/settings/servers">
          <ArrowLeft className="size-4" />
          Servers
        </Link>
      </Button>
      <div className="flex items-center gap-2">
        <h1 className={`${titleClass.page} min-w-0 truncate`} title={title}>
          {name}
        </h1>
        {badges}
        <div className="ml-auto shrink-0">{action}</div>
      </div>
      <p className="mt-1 font-mono text-xs text-muted-foreground">{ip}</p>
    </div>
  );
}

export function ServerDetailHeaderSkeleton() {
  return (
    <ServerDetailHeader
      name={<Bone>server-name</Bone>}
      badges={
        <span className="shrink-0">
          <Bone box className="rounded-full">
            <span className="size-3" />
          </Bone>
        </span>
      }
      action={
        <Button
          variant="outline"
          size="icon"
          className="size-8 shrink-0"
          disabled
          aria-hidden
        >
          <RefreshCw className="size-4" />
        </Button>
      }
      ip={<Bone>203.0.113.10</Bone>}
    />
  );
}
