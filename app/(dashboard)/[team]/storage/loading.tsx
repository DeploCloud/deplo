import { Card } from "@/components/ui/card";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { titleClass } from "@/components/shared/page-header";

const TABS = [
  ["databases", "Databases"],
  ["destinations", "Destinations"],
  ["backups", "Backups"],
] as const;

// [name, engine line, address line] per database card.
const CARDS: [string, string, string][] = [
  ["w-30", "w-24", "w-24"],
  ["w-28", "w-24", "w-16"],
  ["w-20", "w-24", "w-16"],
];

export default function Loading() {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy
      aria-label="Loading storage"
    >
      <div className="space-y-1">
        <TextLine type={titleClass.page} className="w-18" />
        <TextLine
          type="text-sm leading-[1.6]"
          className="w-[514px] max-w-full"
        />
      </div>

      <Tabs defaultValue="databases" className="space-y-3">
        <UnderlineTabsList>
          {TABS.map(([value, label]) => (
            <UnderlineTabsTrigger key={value} value={value}>
              {label}
              <Skeleton className="ml-2 h-[22px] w-[26px]" />
            </UnderlineTabsTrigger>
          ))}
        </UnderlineTabsList>

        <TabsContent value="databases" className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Skeleton className="h-9 flex-1" />
            <Skeleton className="h-9 w-full sm:w-40" />
            <Skeleton className="h-9 w-full sm:w-36" />
            <Skeleton className="hidden h-[38px] w-[74px] rounded-lg sm:block" />
            <Skeleton className="h-9 w-full sm:w-[155px]" />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CARDS.map(([name, engine, address], i) => (
              <Card key={i} className="flex flex-col gap-4 p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Skeleton className="size-9 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <TextLine
                        type="font-medium leading-[1.6]"
                        className={name}
                      />
                      <TextLine
                        type="mt-1 text-xs leading-[1.6]"
                        className={engine}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Skeleton className="size-2.5 rounded-full" />
                    <Skeleton className="size-8" />
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-surface p-3">
                  <div className="flex items-center gap-1.5">
                    <Skeleton className="h-7 flex-1" />
                    <Skeleton className="size-7" />
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <TextLine type="text-xs" className="w-20" />
                    <TextLine type="text-xs" className={address} />
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
