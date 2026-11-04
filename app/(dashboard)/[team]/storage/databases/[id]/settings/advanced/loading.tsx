import { SlidersHorizontal, Sparkles, SquareTerminal } from "lucide-react";
import Link from "@/components/ui/link";
import { Button } from "@/components/ui/button";
import {
  FeatureRow,
  RowsCard,
  SettingsSection,
} from "@/components/apps/settings/settings-shared";
import { SettingsLoading } from "@/components/apps/settings/settings-loading";
import { CronSettingsForm } from "@/components/crons/cron-settings-form";
import { RestartLoopForm } from "@/components/apps/settings/restart-loop-form";
import { DatabaseImageSettings } from "@/components/storage/database-image-settings";
import { DatabaseConfigFiles } from "@/components/storage/database-config-files";
import { DatabaseDanger } from "@/components/storage/database-danger";
import { DB_DATA_DIRS } from "@/lib/deploy/database-compose";
import { PLACEHOLDER_DB } from "../placeholder-db";

export default function Loading() {
  return (
    <SettingsLoading className="space-y-6">
      <SettingsSection
        icon={SlidersHorizontal}
        title="Advanced"
        docs="databases.settings"
        info="Turn on the advanced features, override the engine image or command, rebuild the database from scratch, or delete it."
      />
      <RowsCard
        icon={Sparkles}
        title="Features"
        info="Powerful extras, off the everyday path until you need them."
        docs="databases.settings"
      >
        <FeatureRow
          icon={SquareTerminal}
          title="Console"
          description={
            <>
              Open a terminal in the database&apos;s container and run{" "}
              <span className="font-mono">psql</span>,{" "}
              <span className="font-mono">redis-cli</span> or any other client.
              No SSH needed.
            </>
          }
          control={
            <Button asChild size="sm" variant="outline">
              <Link href="/storage">Open console</Link>
            </Button>
          }
        />
        <CronSettingsForm
          targetKind="database"
          targetId=""
          enabled={false}
          jobCount={0}
        />
        <RestartLoopForm targetKind="database" targetId="" enabled />
      </RowsCard>
      <DatabaseImageSettings db={PLACEHOLDER_DB} />
      <DatabaseConfigFiles
        db={PLACEHOLDER_DB}
        dataDir={DB_DATA_DIRS[PLACEHOLDER_DB.type]}
      />
      <DatabaseDanger db={PLACEHOLDER_DB} canMove />
    </SettingsLoading>
  );
}
