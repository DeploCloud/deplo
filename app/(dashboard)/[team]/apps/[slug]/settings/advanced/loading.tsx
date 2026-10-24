import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  CardHeaderSkeleton,
  FeatureRowSkeleton,
  SectionLabel,
  SwitchSkeleton,
} from "@/components/apps/settings/settings-skeletons";

const FEATURES = [
  ["w-14", "w-[560px]"],
  ["w-[113px]", "w-[610px]"],
  ["w-22", "w-[390px]"],
  ["w-[183px]", "w-[290px]"],
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
        <CardHeaderSkeleton title="w-[96px]" icon info />
        {FEATURES.map(([title, description]) => (
          <FeatureRowSkeleton
            key={title}
            title={title}
            description={description}
          >
            <SwitchSkeleton />
          </FeatureRowSkeleton>
        ))}
        <FeatureRowSkeleton title="w-[130px]" description="w-[410px]">
          <Skeleton className="h-8 w-[84px]" />
        </FeatureRowSkeleton>
      </Card>

      <Card>
        <CardHeaderSkeleton title="w-[150px]" icon info />
        <FeatureRowSkeleton title="w-[96px]" description="w-[467px]">
          <Skeleton className="h-8 w-[121px]" />
          <SwitchSkeleton />
        </FeatureRowSkeleton>
        <FeatureRowSkeleton title="w-[96px]" description="w-[290px]">
          <Skeleton className="h-9 w-56" />
        </FeatureRowSkeleton>
        <FeatureRowSkeleton title="w-[140px]" description="w-[470px]">
          <span />
        </FeatureRowSkeleton>
        <FeatureRowSkeleton title="w-[136px]" description="w-[560px]">
          <Skeleton className="h-8 w-[150px]" />
        </FeatureRowSkeleton>
      </Card>

      <Card>
        <CardHeaderSkeleton title="w-[120px]" icon info />
        <CardContent>
          <Skeleton className="h-40 w-full rounded-md" />
        </CardContent>
        <CardFooter className="justify-end border-t border-border pt-4">
          <Skeleton className="h-9 w-20 rounded-md" />
        </CardFooter>
      </Card>
    </section>
  );
}
