import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  CardFooterSkeleton,
  CardHeaderSkeleton,
  P_SM,
  P_XS,
  SectionLabel,
} from "@/components/apps/settings/settings-skeletons";

// Mirrors the empty picker, the state of an app with nothing mounted.
const KINDS = [
  ["w-14", "w-[270px]", "w-[269px]"],
  ["w-7", "w-[222px]", "w-[292px]"],
] as const;

export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading storage settings"
    >
      <SectionLabel width="w-16" trail="docs" />
      <Card>
        <CardHeaderSkeleton title="w-[146px]" info />
        <CardContent>
          <div className="rounded-xl border border-dashed border-border p-6">
            <div className="mb-5 flex flex-col items-center gap-2">
              <Skeleton className="size-10 rounded-lg" />
              <TextLine type={P_SM} className="w-[102px]" />
              <div className="flex w-full max-w-md flex-col items-center">
                <TextLine type={P_XS} className="w-[446px] max-w-full" />
                <TextLine type={P_XS} className="w-[213px]" />
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {KINDS.map(([label, line, example]) => (
                <div
                  key={label}
                  className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
                >
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-4 rounded" />
                    <TextLine type="text-sm" className={label} />
                  </div>
                  <TextLine type="text-xs" className={line} />
                  <TextLine type="text-xs" className={example} />
                </div>
              ))}
            </div>
            <div className="mt-2 flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2">
              <Skeleton className="size-3.5 shrink-0 rounded" />
              <TextLine type="text-xs" className="w-[230px] max-w-full" />
            </div>
          </div>
          <TextLine type={`mt-3 ${P_XS}`} className="w-[966px] max-w-full" />
        </CardContent>
        <CardFooterSkeleton>
          <Skeleton className="h-8 w-[129px]" />
        </CardFooterSkeleton>
      </Card>
    </section>
  );
}
