import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";

export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading Automatic DNS"
    >
      <div className="space-y-1">
        <div className={`flex items-center gap-2 ${titleClass.page}`}>
          <TextLine className="w-36" />
          <Skeleton className="h-[18px] w-9" />
        </div>
        <TextLine
          type="text-sm leading-[1.6]"
          className="w-[30rem] max-w-full"
        />
      </div>
      <div className="max-w-xl space-y-6">
        <div className="flex items-center gap-1">
          {["w-[78px]", "w-[74px]", "w-[60px]", "w-[54px]"].map((w, i) => (
            <div key={w} className="flex items-center gap-1">
              {i > 0 && (
                <span aria-hidden className="w-3 border-t border-border" />
              )}
              <Skeleton className={`h-7 ${w}`} />
            </div>
          ))}
        </div>
        <div className="grid w-full gap-2 sm:grid-cols-2">
          <div className="flex w-full items-start gap-3 rounded-lg border border-border p-3">
            <Skeleton className="size-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <TextLine type="text-sm font-medium" className="w-20" />
              <TextLine
                type="mt-0.5 text-xs leading-snug"
                className="w-40 max-w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
