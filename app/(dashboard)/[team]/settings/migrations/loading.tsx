import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { MigrationGraphic } from "@/components/settings/migrations/migration-graphic";

// The Migrate tab's first screen: what are you migrating, two choices.
export default function Loading() {
  return (
    <div
      className="space-y-3"
      role="status"
      aria-busy
      aria-label="Loading migrations"
    >
      <div className="space-y-1">
        <div className={`flex items-center gap-2 ${titleClass.page}`}>
          <TextLine className="w-28" />
          <Skeleton className="h-[18px] w-9" />
        </div>
        <TextLine type="text-sm leading-[1.6]" className="w-72 max-w-full" />
      </div>

      <div className="space-y-3">
        <div className="border-b border-border">
          <div className="flex h-12 items-center gap-1">
            <Skeleton className="h-5 w-[88px]" />
            <Skeleton className="h-5 w-[80px]" />
          </div>
        </div>

        <div className="mx-auto flex w-full flex-col items-center gap-8 pt-8">
          <MigrationGraphic
            state="connect"
            grid
            className="h-auto w-full max-w-md"
          />

          <div className="w-full max-w-xl min-w-0">
            <div className="flex flex-col items-stretch gap-10">
              <div>
                <TextLine
                  type="justify-center text-3xl font-semibold tracking-tight sm:text-4xl"
                  className="w-96 max-w-full"
                />
                <div className="mx-auto mt-2 max-w-md">
                  <TextLine
                    type="justify-center leading-loose"
                    className="w-96 max-w-full"
                  />
                  <TextLine
                    type="justify-center leading-loose"
                    className="w-56"
                  />
                </div>
              </div>
              <div className="grid gap-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  {["w-28", "w-36"].map((w) => (
                    <div
                      key={w}
                      className="flex w-full items-start gap-3 rounded-lg border border-border bg-background p-3"
                    >
                      <Skeleton className="size-8 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <TextLine type="text-sm font-medium" className={w} />
                        <TextLine
                          type="mt-1 text-xs leading-relaxed"
                          className="w-full"
                        />
                        <TextLine
                          type="text-xs leading-relaxed"
                          className="w-24"
                        />
                      </div>
                      <Skeleton className="mt-0.5 size-4 shrink-0" />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
