import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { ConnectGraphic } from "@/components/settings/mcp/connect-graphic";

// The agent picker, the first step once MCP is on; six of its cards.
const AGENTS = ["w-14", "w-16", "w-24", "w-14", "w-16", "w-20"];

export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-busy aria-label="Loading MCP">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className={`flex items-center gap-2 ${titleClass.page}`}>
            <TextLine className="w-28" />
            <Skeleton className="h-[18px] w-9" />
          </div>
          <TextLine
            type="text-sm leading-[1.6]"
            className="w-[30rem] max-w-full"
          />
        </div>
        <div className="flex items-center gap-1">
          <TextLine type="text-sm" className="w-36" />
          <Skeleton className="size-8" />
        </div>
      </div>

      <div className="grid gap-8 xl:grid-cols-[minmax(0,1fr)_clamp(24rem,30vw,36rem)] xl:gap-12">
        <div className="relative order-first flex justify-center pt-2 xl:sticky xl:top-24 xl:order-last xl:self-start xl:pt-16">
          <ConnectGraphic state="idle" className="h-auto w-64 xl:w-full" />
        </div>

        <div className="max-w-xl min-w-0 space-y-6">
          <div className="flex items-center gap-1">
            {["w-[70px]", "w-[84px]", "w-[66px]"].map((w, i) => (
              <div key={w} className="flex items-center gap-1">
                {i > 0 && (
                  <span aria-hidden className="w-3 border-t border-border" />
                )}
                <Skeleton className={`h-7 ${w}`} />
              </div>
            ))}
          </div>

          <div className="flex flex-col items-start gap-5">
            <div>
              <TextLine
                type="text-base font-semibold lg:text-lg"
                className="w-72"
              />
              <TextLine type="mt-1 text-sm leading-[1.6]" className="w-64" />
            </div>
            <div className="grid w-full gap-2 sm:grid-cols-2">
              {AGENTS.map((w, i) => (
                <div
                  key={i}
                  className="flex w-full items-start gap-3 rounded-lg border border-border p-3"
                >
                  <Skeleton className="size-8 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <TextLine type="text-sm font-medium" className={w} />
                    <TextLine
                      type="mt-0.5 text-xs leading-snug"
                      className="w-40 max-w-full"
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
