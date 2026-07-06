import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div
      className="space-y-5"
      role="status"
      aria-busy
      aria-label="Loading console"
    >
      {/* PageHeader: title "Console" + description */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>

      {/* ContainerConsole: bordered panel with toolbar + terminal body */}
      <div className="overflow-hidden rounded-xl border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
          <Skeleton className="size-4" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-5 w-20 rounded-md" />
          <Skeleton className="h-7 w-16 rounded-md" />
          <Skeleton className="ml-auto h-3 w-56" />
        </div>
        <div className="h-[420px] space-y-2 bg-black/90 p-3">
          <Skeleton className="h-3 w-64" />
          <Skeleton className="h-3 w-52" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    </div>
  );
}
