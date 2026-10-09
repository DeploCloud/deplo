import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { ContainerMonitoringSkeleton } from "@/components/monitoring/container-monitoring-skeleton";

export default function Loading() {
  return (
    <div
      className="space-y-5"
      role="status"
      aria-busy
      aria-label="Loading monitoring"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <TextLine type={titleClass.section} className="w-23" />
          <TextLine
            type="text-sm leading-[1.6]"
            className="w-[34rem] max-w-full"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Skeleton className="size-4 shrink-0 rounded" />
            <TextLine type="text-sm" className="w-16" />
          </div>
          <Skeleton className="h-8 w-[71px]" />
          <div className="flex size-8 items-center justify-center">
            <Skeleton className="size-4 rounded" />
          </div>
        </div>
      </div>
      <ContainerMonitoringSkeleton />
    </div>
  );
}
