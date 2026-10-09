import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";

// A <p> carries a 1.6 line-height (globals.css), so its stand-ins do too.
const P = "leading-[1.6]";

function TileLabel({ width }: { width: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Skeleton className="size-4 shrink-0 rounded" />
      <TextLine type="text-xs" className={width} />
    </div>
  );
}

function GaugeTileSkeleton({ label }: { label: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className="flex size-[92px] shrink-0 items-center justify-center">
          <Skeleton className="size-[85px] rounded-full border-[7px] border-muted bg-transparent" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <TileLabel width={label} />
          <TextLine type={`text-2xl ${P}`} className="w-20" />
          <TextLine type={`text-xs ${P}`} className="w-32 max-w-full" />
        </div>
      </CardContent>
    </Card>
  );
}

function ChartCardSkeleton({
  title,
  caption,
  legend,
  action,
}: {
  title: string;
  caption?: boolean;
  legend?: boolean;
  action?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <TextLine type="text-sm" className={title} />
          {action && <TextLine type="text-xs" className="w-16" />}
        </div>
        {caption && <TextLine type={`text-xs ${P}`} className="w-36" />}
      </CardHeader>
      <CardContent>
        <Skeleton className="h-[200px] w-full rounded-lg" />
        {legend && (
          <div className="flex items-center gap-x-4 pt-2">
            {["w-28", "w-20"].map((w) => (
              <div key={w} className="flex items-center gap-1.5">
                <Skeleton className="h-0.5 w-3 rounded-full" />
                <TextLine type="text-xs" className={w} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** The live dashboard's body once metrics stream: status line, tiles, charts. */
export function ContainerMonitoringSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-2 rounded-full" />
          <TextLine type="text-xs" className="w-[5.5rem]" />
        </div>
        <Skeleton className="h-[30px] w-[213px] rounded-lg" />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <GaugeTileSkeleton label="w-8" />
        <GaugeTileSkeleton label="w-12" />
        <Card>
          <CardContent className="space-y-1.5 p-4">
            <TileLabel width="w-12" />
            <TextLine type="text-lg" className="w-24" />
            <TextLine type="text-sm" className="w-20" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-2 p-4">
            <TileLabel width="w-14" />
            <TextLine type={`text-2xl ${P}`} className="w-10" />
            <TextLine type={`text-xs ${P}`} className="w-28" />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCardSkeleton title="w-20" caption />
        <ChartCardSkeleton title="w-24" caption />
        <ChartCardSkeleton title="w-20" legend />
        <ChartCardSkeleton title="w-14" legend action />
      </div>
    </div>
  );
}
