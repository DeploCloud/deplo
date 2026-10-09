import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  CardHeaderSkeleton,
  CompactRowTextSkeleton,
  FeatureRowSkeleton,
  SectionLabel,
  SwitchSkeleton,
} from "@/components/apps/settings/settings-skeletons";

const FEATURES = [
  ["w-14", "w-[642px]"],
  ["w-[113px]", "w-[705px]"],
  ["w-22", "w-[447px]"],
  ["w-[183px]", "w-[332px]"],
] as const;

export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading advanced settings"
    >
      <SectionLabel width="w-18" trail="info" />

      <Card>
        <CardHeaderSkeleton title="w-[163px]" description="w-[381px]" />
        <CardContent className="space-y-3">
          {FEATURES.map(([title, description]) => (
            <FeatureRowSkeleton
              key={title}
              title={title}
              description={description}
            >
              <SwitchSkeleton />
            </FeatureRowSkeleton>
          ))}
          <FeatureRowSkeleton title="w-[130px]" description="w-[472px]">
            <Skeleton className="h-9 w-[94px]" />
          </FeatureRowSkeleton>
        </CardContent>
      </Card>

      <Card>
        <CardHeaderSkeleton title="w-[130px]" description="w-[580px]" />
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
            <CompactRowTextSkeleton title="w-[78px]" description="w-[467px]" />
            <div className="flex shrink-0 items-center gap-3">
              <Skeleton className="h-8 w-[121px]" />
              <SwitchSkeleton />
            </div>
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CompactRowTextSkeleton
                title="w-[96px]"
                description="w-[250px]"
              />
              <Skeleton className="h-9 w-full shrink-0 sm:w-56" />
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
              <CompactRowTextSkeleton
                title="w-[300px]"
                description="w-[282px]"
              />
              <SwitchSkeleton />
            </div>
          </div>
          <div className="space-y-3 rounded-lg border border-border p-3">
            <CompactRowTextSkeleton title="w-[140px]" description="w-[519px]" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-9 min-w-0 flex-1" />
              <Skeleton className="h-8 w-[79px] shrink-0" />
            </div>
            <div className="rounded-md border border-border px-3 py-2">
              <TextLine
                type="font-mono text-xs"
                className="w-[620px] max-w-full"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeaderSkeleton
          title="w-[149px]"
          description="w-[715px]"
          icon
          info
        />
        <CardFooter className="justify-end">
          <Skeleton className="h-8 w-[155px]" />
        </CardFooter>
      </Card>

      <Card>
        <CardHeaderSkeleton title="w-[107px]" description="w-[593px]" info />
        <CardContent className="space-y-3">
          <FeatureRowSkeleton
            title="w-[172px]"
            description="w-[469px]"
            icon={false}
          >
            <Skeleton className="h-8 w-[101px]" />
          </FeatureRowSkeleton>
          <FeatureRowSkeleton
            title="w-[76px]"
            description="w-[690px]"
            icon={false}
          >
            <Skeleton className="h-8 w-[116px]" />
          </FeatureRowSkeleton>
        </CardContent>
      </Card>
    </section>
  );
}
