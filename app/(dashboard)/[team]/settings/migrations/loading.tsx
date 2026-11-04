import { PageHeader } from "@/components/shared/page-header";
import { BetaChip } from "@/components/shared/beta-chip";
import { MigrationsTabsSkeleton } from "@/components/settings/migrations/migrations-tabs";

export default function Loading() {
  return (
    <div className="space-y-3" aria-busy>
      <PageHeader
        docs="migration.dokploy"
        title={
          <span className="flex items-center gap-2">
            Migrations
            <BetaChip />
          </span>
        }
        description="Bring another Deplo, Dokploy or Coolify here."
      />
      <MigrationsTabsSkeleton />
    </div>
  );
}
