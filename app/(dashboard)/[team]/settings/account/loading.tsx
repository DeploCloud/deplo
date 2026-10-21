import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { AccountGraphic } from "@/components/settings/account-graphic";

const CARD_TITLE = "text-base leading-none font-semibold lg:text-lg";
const SHORTCUTS: [string, string][] = [
  ["w-16", "w-24"],
  ["w-20", "w-8"],
  ["w-16", "w-20"],
  ["w-16", "w-14"],
];

function Field({ label }: { label: string }) {
  return (
    <div className="space-y-2">
      <TextLine type="text-sm leading-none" className={label} />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading account"
    >
      <div className="space-y-1">
        <TextLine type={titleClass.page} className="w-20" />
        <TextLine type="text-sm leading-[1.6]" className="w-64 max-w-full" />
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 lg:grid-cols-2">
          <Card className="flex flex-col">
            <CardHeader>
              <TextLine type={CARD_TITLE} className="w-16" />
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
                <Skeleton className="size-16 rounded-full" />
                <div className="min-w-0">
                  <TextLine
                    type="text-base leading-[1.6] font-medium"
                    className="w-32"
                  />
                  <TextLine
                    type="mt-1 text-sm leading-[1.6]"
                    className="w-24"
                  />
                  <div className="mt-2 flex items-center gap-1.5">
                    <Skeleton className="h-[18px] w-24" />
                    <Skeleton className="h-[18px] w-16" />
                  </div>
                </div>
              </div>
              <div className="mt-auto space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="w-24" />
                  <Field label="w-16" />
                </div>
                <div className="flex justify-end">
                  <Skeleton className="h-8 w-[58px]" />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="flex flex-col">
            <CardHeader>
              <TextLine type={CARD_TITLE} className="w-14" />
            </CardHeader>
            <CardContent className="flex flex-1 flex-col gap-4">
              <Field label="w-10" />
              <Field label="w-32" />
              <div className="mt-auto flex justify-end">
                <Skeleton className="h-8 w-[110px]" />
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <TextLine type={CARD_TITLE} className="w-20" />
          </CardHeader>
          <CardContent className="flex flex-col items-center gap-6 sm:flex-row">
            <AccountGraphic className="shrink-0" />
            <div className="grid w-full flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {SHORTCUTS.map(([label, status], i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <Skeleton className="size-9 shrink-0 rounded-full" />
                  <div className="min-w-0 flex-1">
                    <TextLine
                      type="text-sm leading-[1.6] font-medium"
                      className={label}
                    />
                    <TextLine
                      type="mt-1 text-xs leading-[1.6]"
                      className={status}
                    />
                  </div>
                  <Skeleton className="size-4 shrink-0" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
