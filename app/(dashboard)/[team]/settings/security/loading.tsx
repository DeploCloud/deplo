import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

const CARD_TITLE = "text-base leading-none font-semibold";

function Field() {
  return (
    <div className="space-y-2">
      <TextLine type="text-sm leading-none" className="w-32" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

export default function Loading() {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy
      aria-label="Loading security"
    >
      <div className="space-y-1">
        <TextLine type={titleClass.page} className="w-20" />
        <TextLine type="text-sm leading-[1.6]" className="w-96 max-w-full" />
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border">
          <div className="flex h-12 items-center gap-1">
            <Skeleton className="h-5 w-[86px]" />
            <Skeleton className="h-5 w-[92px]" />
          </div>
          <TextLine type="pb-3 text-sm" className="w-36" />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="flex flex-col">
            <CardHeader>
              <TextLine type={CARD_TITLE} className="w-40" />
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              <div className="flex min-h-0 flex-1 items-center justify-center py-2">
                <Skeleton className="h-20 w-28" />
              </div>
              <div>
                <TextLine
                  type="text-sm font-medium leading-[1.6]"
                  className="w-64"
                />
                <TextLine type="mt-1 text-sm leading-[1.6]" className="w-48" />
              </div>
              <div className="mt-auto flex w-full items-center gap-3 rounded-lg border border-border p-3">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <TextLine type="text-sm font-medium" className="w-52" />
                  <TextLine type="mt-1 text-xs" className="w-64 max-w-full" />
                </div>
                <Skeleton className="size-4 shrink-0" />
              </div>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader>
              <TextLine type={CARD_TITLE} className="w-24" />
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              <Field />
              <div className="grid items-start gap-4 xl:grid-cols-2">
                <Field />
                <Field />
              </div>
              <div className="mt-auto flex justify-end">
                <Skeleton className="h-8 w-36" />
              </div>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader>
              <TextLine type={CARD_TITLE} className="w-56" />
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Skeleton className="size-5 shrink-0 rounded-full" />
                  <div>
                    <TextLine type="text-sm font-medium" className="w-10" />
                    <TextLine
                      type="mt-1 text-sm leading-[1.6]"
                      className="w-72 max-w-full"
                    />
                  </div>
                </div>
                <Skeleton className="h-9 w-20 shrink-0" />
              </div>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
              <div className="flex items-center gap-2">
                <TextLine type={CARD_TITLE} className="w-20" />
                <Skeleton className="h-[18px] w-9" />
              </div>
              <Skeleton className="h-8 w-28 shrink-0" />
            </CardHeader>
            <CardContent className="flex flex-1 flex-col">
              <div className="flex items-center gap-x-3 rounded-lg border border-border p-3">
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1">
                  <TextLine
                    type="text-sm font-medium leading-[1.6]"
                    className="w-32"
                  />
                  <TextLine
                    type="mt-1 text-xs leading-[1.6]"
                    className="w-40"
                  />
                </div>
                <Skeleton className="size-8 shrink-0" />
                <Skeleton className="size-8 shrink-0" />
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
