import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { TwoFactorGraphic } from "@/components/settings/two-factor-graphic";
import { AgentsGraphic } from "@/components/settings/agents-graphic";

const CARD_TITLE = "text-base leading-none font-semibold lg:text-lg";

function SettingBox({ wide }: { wide?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
      <div className="space-y-1">
        <TextLine type="text-sm font-medium leading-[1.6]" className="w-36" />
        <TextLine
          type="text-xs leading-[1.6]"
          className={wide ? "w-56" : "w-44"}
        />
      </div>
      <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
    </div>
  );
}

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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Card className="flex flex-col">
          <CardHeader>
            <TextLine type={CARD_TITLE} className="w-16" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <div className="flex flex-1 flex-col items-center justify-center gap-2.5 py-2">
              <Skeleton className="size-20 rounded-full" />
              <TextLine type="text-xs leading-[1.6]" className="w-44" />
            </div>
            <div className="space-y-2 rounded-lg border border-border p-3">
              <TextLine
                type="text-sm leading-none font-medium"
                className="w-20"
              />
              <Skeleton className="h-9 w-full" />
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <TextLine type={CARD_TITLE} className="w-20" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <div className="flex min-h-0 flex-1 items-center justify-center py-2">
              <TwoFactorGraphic className="max-h-20" />
            </div>
            <SettingBox />
          </CardContent>
        </Card>

        <Card className="flex flex-col md:col-span-2 xl:col-span-1">
          <CardHeader>
            <TextLine type={CARD_TITLE} className="w-20" />
          </CardHeader>
          <CardContent className="flex flex-1 flex-col gap-3">
            <div className="flex min-h-0 flex-1 items-center justify-center py-2">
              <AgentsGraphic className="max-h-20" />
            </div>
            <SettingBox wide />
          </CardContent>
        </Card>

        <Card className="md:col-span-2 xl:col-span-3">
          <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
            <TextLine type={CARD_TITLE} className="w-32" />
            <Skeleton className="h-8 w-36" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-[73px] w-full rounded-xl" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
