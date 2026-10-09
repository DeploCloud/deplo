import { Skeleton, TextLine } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import {
  AccordionRowSkeleton,
  CardFooterSkeleton,
  CardHeaderSkeleton,
  FieldLabelSkeleton,
  P_SM,
  SectionLabel,
  SwitchSkeleton,
} from "@/components/apps/settings/settings-skeletons";

function SettingRowSkeleton({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-3">
      <FieldLabelSkeleton width={label} info />
      <SwitchSkeleton />
    </div>
  );
}

function FieldSkeleton({ label }: { label: string }) {
  return (
    <div className="grid gap-1.5">
      <FieldLabelSkeleton width={label} info />
      <Skeleton className="h-9 w-full" />
    </div>
  );
}

export default function Loading() {
  return (
    <section
      className="space-y-4"
      role="status"
      aria-busy
      aria-label="Loading pull request settings"
    >
      <SectionLabel width="w-27" trail="info" />
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <TextLine type={P_SM} className="w-[190px]" />
                <TextLine
                  type={`mt-1 ${P_SM}`}
                  className="w-[878px] max-w-full"
                />
              </div>
              <SwitchSkeleton />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeaderSkeleton title="w-[184px]" />
          <CardContent className="space-y-4">
            <FieldSkeleton label="w-[110px]" />
            <SettingRowSkeleton label="w-12" />
            <SettingRowSkeleton label="w-[170px]" />
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldSkeleton label="w-24" />
              <FieldSkeleton label="w-8" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <AccordionRowSkeleton width="w-[69px]" className="px-6" />
          <CardFooterSkeleton>
            <Skeleton className="h-8 w-[78px]" />
          </CardFooterSkeleton>
        </Card>
      </div>
    </section>
  );
}
