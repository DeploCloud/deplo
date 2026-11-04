import { MoreHorizontal, RotateCcwClock, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Bone, Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/shared/status-badge";
import { titleClass } from "@/components/shared/page-header";

// The App page header; the layout fills the slots, the loading state bones them.
export function AppHeader({
  logo,
  name,
  status,
  subtitle,
  actions,
}: {
  logo: React.ReactNode;
  name: React.ReactNode;
  status: React.ReactNode;
  subtitle: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          {logo}
          <div>
            <div className="flex items-center gap-2">
              <h1 className={titleClass.page}>{name}</h1>
              {status}
            </div>
            {subtitle}
          </div>
        </div>
        {/* Below md the redeploy takes the whole first row; the rest share the second. */}
        <div className="flex flex-wrap items-center gap-2 max-md:grid max-md:grid-cols-[1fr_1fr_auto] max-md:[&>:has([data-primary-action])]:order-first max-md:[&>:has([data-primary-action])]:col-span-full max-md:[&>:last-child]:col-start-3 max-md:[&>[data-primary-action]]:order-first max-md:[&>[data-primary-action]]:col-span-full">
          {actions}
        </div>
      </div>
    </div>
  );
}

// A grid cell on a phone stretches; the bone and its button have to follow.
const STRETCH = "max-md:w-auto max-md:[&>*]:flex-1";

export function AppHeaderSkeleton() {
  return (
    <AppHeader
      logo={
        <span className="inline-flex shrink-0 rounded-md">
          <Skeleton className="size-11 rounded-md" />
        </span>
      }
      name={<Bone>Loading app</Bone>}
      status={
        <Bone box>
          <StatusBadge status="active" tinted labels={{ active: "Online" }} />
        </Bone>
      }
      subtitle={
        <span className="flex text-sm text-muted-foreground">
          <Bone>web-app.example.com</Bone>
        </span>
      }
      actions={
        <>
          <Bone box className={STRETCH}>
            <Button variant="outline" size="sm" disabled>
              <RotateCcwClock className="size-4" />
              Rollback
            </Button>
          </Bone>
          <Bone box className={STRETCH}>
            <Button size="sm" disabled data-primary-action="">
              <RotateCw className="size-4" />
              Redeploy
            </Button>
          </Bone>
          <Bone box>
            <Button variant="outline" size="icon-sm" disabled>
              <MoreHorizontal className="size-4" />
            </Button>
          </Bone>
        </>
      }
    />
  );
}
