import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { LogsGraphic } from "@/components/apps/logs-graphic";
import { titleClass } from "@/components/shared/page-header";
import { cn } from "@/lib/utils";

// Mirrors LogChooser: the page with no log picked yet.
export default function Loading() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-start overflow-y-auto p-6 pt-10 pb-24 sm:pt-14"
      role="status"
      aria-busy
      aria-label="Loading logs"
    >
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center text-center">
          <LogsGraphic grid className="size-auto w-72" />
          <TextLine
            type={cn("mt-8", titleClass.page)}
            className="w-[17.5rem]"
          />
          <TextLine
            type="mt-1 text-sm leading-[1.6]"
            className="w-[20.375rem]"
          />
        </div>
        <Skeleton className="mt-6 h-9 w-full" />
      </div>
    </div>
  );
}
