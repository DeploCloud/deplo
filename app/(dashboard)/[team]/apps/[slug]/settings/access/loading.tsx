import { Skeleton, TextLine } from "@/components/ui/skeleton";
import {
  InfoDot,
  P_SM,
  SectionLabel,
} from "@/components/apps/settings/settings-skeletons";

// Mirrors the usual empty state: most apps have no credential.
export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading access settings"
    >
      <SectionLabel width="w-13" trail="docs" />
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <TextLine type="text-sm" className="w-28" />
              <InfoDot />
            </div>
            <TextLine type={`mt-1 ${P_SM}`} className="w-[904px] max-w-full" />
          </div>
          <Skeleton className="h-8 w-[136px] shrink-0" />
        </div>
        <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-16">
          <Skeleton className="mb-4 size-12 rounded-full" />
          <TextLine type="text-sm" className="w-[117px]" />
          <div className="mt-1 flex w-full max-w-sm flex-col items-center">
            <TextLine type={P_SM} className="w-[372px] max-w-full" />
            <TextLine type={P_SM} className="w-[184px]" />
          </div>
        </div>
      </div>
    </section>
  );
}
