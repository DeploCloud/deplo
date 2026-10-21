import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { TwoFactorGraphic } from "@/components/settings/two-factor-graphic";

const CARD_TITLE = "text-base leading-none font-semibold lg:text-lg";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading general settings"
    >
      <div className="space-y-1">
        <TextLine type={titleClass.page} className="w-20" />
        <TextLine type="text-sm leading-[1.6]" className="w-60" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <TextLine type={CARD_TITLE} className="w-16" />
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
              <Skeleton className="size-16 rounded-xl" />
              <div>
                <TextLine
                  type="text-base font-medium leading-[1.6]"
                  className="w-28"
                />
                <TextLine
                  type="mt-1.5 text-xs leading-[1.6]"
                  className="w-80 max-w-full"
                />
              </div>
            </div>
            <div className="space-y-2">
              <TextLine
                type="text-sm leading-none font-medium"
                className="w-20"
              />
              <Skeleton className="h-9 w-full" />
            </div>
            <div className="flex justify-end">
              <Skeleton className="h-8 w-[118px]" />
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <TextLine type={CARD_TITLE} className="w-40" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <div className="flex min-h-0 flex-1 items-center justify-center py-2">
              <TwoFactorGraphic className="max-h-20" />
            </div>
            <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
              <div className="space-y-1">
                <TextLine
                  type="text-sm font-medium leading-[1.6]"
                  className="w-48"
                />
                <TextLine type="text-xs leading-[1.6]" className="w-72" />
              </div>
              <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
            </div>
          </CardContent>
        </Card>

        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <TextLine type={CARD_TITLE} className="w-28" />
            </CardHeader>
            <CardContent className="grid gap-6 md:grid-cols-2">
              {["w-36", "w-24"].map((title) => (
                <div
                  key={title}
                  className="flex flex-col justify-between gap-3"
                >
                  <div className="min-w-0">
                    <TextLine
                      type="text-sm font-medium leading-[1.6]"
                      className={title}
                    />
                    <TextLine
                      type="mt-1 text-xs leading-[1.6]"
                      className="w-80 max-w-full"
                    />
                  </div>
                  <Skeleton className="h-8 w-40" />
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
