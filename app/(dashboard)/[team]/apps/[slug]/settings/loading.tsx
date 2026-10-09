import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  CardFooterSkeleton,
  FieldLabelSkeleton,
  P_SM,
  P_XS,
  SectionLabel,
} from "@/components/apps/settings/settings-skeletons";

export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading general settings"
    >
      <SectionLabel width="w-15" trail="docs" />
      <Card>
        <CardContent className="space-y-6 pt-6">
          <div className="space-y-3">
            <FieldLabelSkeleton width="w-8" info />
            <div className="flex flex-wrap items-center gap-4">
              <Skeleton className="size-12 rounded-full" />
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-8 w-[139px]" />
                <Skeleton className="h-8 w-[169px]" />
                <Skeleton className="h-8 w-[66px]" />
              </div>
            </div>
            <TextLine type={P_XS} className="w-[453px] max-w-full" />
          </div>
          <div className="max-w-md space-y-2 border-t border-border pt-6">
            <FieldLabelSkeleton width="w-[68px]" />
            <Skeleton className="h-9 w-full" />
          </div>
        </CardContent>
        <CardFooterSkeleton>
          <Skeleton className="h-8 w-[114px]" />
        </CardFooterSkeleton>
      </Card>
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
          <div className="min-w-56 flex-1 space-y-1">
            <FieldLabelSkeleton width="w-[46px]" info />
            <div className="flex items-center gap-2">
              <Skeleton className="size-4 rounded" />
              <TextLine type={P_SM} className="w-32" />
            </div>
          </div>
          <Skeleton className="h-8 w-[83px]" />
        </CardContent>
      </Card>
    </section>
  );
}
