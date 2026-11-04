import { PageHeader } from "@/components/shared/page-header";
import { CronJobsListSkeleton } from "@/components/crons/cron-jobs-list";

export default function Loading() {
  return (
    <div className="space-y-5" aria-busy>
      <PageHeader
        level="section"
        docs="cron.overview"
        title="Cron jobs"
        description="Commands run inside this database's container on a schedule."
      />
      <CronJobsListSkeleton />
    </div>
  );
}
