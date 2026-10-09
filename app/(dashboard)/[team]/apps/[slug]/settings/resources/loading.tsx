import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  AccordionRowSkeleton,
  CardFooterSkeleton,
  CardHeaderSkeleton,
  FieldLabelSkeleton,
  P_SM,
  P_XS,
  SectionLabel,
} from "@/components/apps/settings/settings-skeletons";

// No limit, then the five presets; "No limit" carries one caption, the rest two.
const TILES = ["w-14", "w-9", "w-9", "w-10", "w-14", "w-10"];

function LimitCellSkeleton({ label }: { label: string }) {
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <FieldLabelSkeleton width={label} info />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="flex h-4 items-center">
        <Skeleton className="h-2 flex-1 rounded-full" />
      </div>
      <div className="space-y-0.5">
        <TextLine type={P_XS} className="w-28" />
        <TextLine type={P_XS} className="w-40" />
      </div>
    </div>
  );
}

export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading resource settings"
    >
      <SectionLabel width="w-20" trail="info" />
      <Card>
        <CardHeaderSkeleton title="w-[129px]" description="w-[432px]" icon />
        <CardContent className="space-y-3">
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {TILES.map((width, i) => (
              <div
                key={i}
                className="flex flex-col items-start gap-0.5 rounded-lg border border-border px-3 py-2"
              >
                <TextLine type="text-sm" className={width} />
                <TextLine type="text-xs" className="w-14" />
                {i > 0 && <TextLine type="text-xs" className="w-12" />}
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <LimitCellSkeleton label="w-[90px]" />
            <LimitCellSkeleton label="w-[62px]" />
            <div className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:col-span-2 lg:col-span-1">
              <div className="flex items-center gap-2">
                <Skeleton className="size-4 shrink-0 rounded" />
                <TextLine type="text-sm" className="w-48" />
              </div>
              <div className="space-y-0.5">
                <TextLine type={P_SM} className="w-56" />
                <TextLine type={P_XS} className="w-44" />
              </div>
              <Skeleton className="mt-auto h-8 w-[58px]" />
            </div>
          </div>
          <AccordionRowSkeleton
            width="w-[110px]"
            className="border-t border-border"
          />
        </CardContent>
        <CardFooterSkeleton>
          <Skeleton className="h-8 w-[82px]" />
          <Skeleton className="h-8 w-[113px]" />
        </CardFooterSkeleton>
      </Card>
    </section>
  );
}
