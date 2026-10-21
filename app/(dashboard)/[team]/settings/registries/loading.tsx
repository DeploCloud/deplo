import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { titleClass } from "@/components/shared/page-header";
import { RegistryGraphic } from "@/components/settings/registry-graphic";

// Most teams have no registry, so this mirrors the empty state.
export default function Loading() {
  return (
    <div
      className="space-y-6"
      role="status"
      aria-busy
      aria-label="Loading registries"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className={`flex items-center gap-2 ${titleClass.page}`}>
            <TextLine className="w-24" />
            <Skeleton className="h-[22px] w-11" />
          </div>
          <TextLine type="text-sm leading-[1.6]" className="w-104 max-w-full" />
        </div>
        <Skeleton className="h-8 w-30" />
      </div>

      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-20 text-center">
        <div className="mb-6 flex items-center justify-center [&>svg]:[zoom:1.5]">
          <RegistryGraphic />
        </div>
        <TextLine type="text-base font-semibold" className="w-48" />
        <div className="mt-1 flex w-full max-w-md flex-col items-center">
          <TextLine type="text-sm leading-[1.6]" className="w-full" />
          <TextLine type="text-sm leading-[1.6]" className="w-64" />
        </div>
      </div>
    </div>
  );
}
