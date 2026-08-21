import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { hasCapability, reachesWholeTeam } from "@/lib/membership";
import { getDokployImport } from "@/lib/data/dokploy-import";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OutsideYourAccess } from "@/components/shared/outside-your-access";
import { PageHeader } from "@/components/shared/page-header";
import { ImportReport } from "@/components/settings/import/import-report";

export const metadata = { title: "Settings · Import report" };

/**
 * One import's report, after the fact.
 *
 * The wizard shows this list once, in the tab that ran the import — and the
 * lines that matter are the ones saying "this one needs a person", which is
 * exactly the reading you do the next morning. Without this page, closing the
 * tab was losing them.
 *
 * Same gate as the import itself, and `getDokployImport` filters by the active
 * team, so another team's run reads as not found rather than as a refusal.
 */
export default async function ImportReportPage(
  props: PageProps<"/settings/import/[id]">,
) {
  const { id } = await props.params;
  if (!(await reachesWholeTeam()) || !(await hasCapability("create_projects")))
    return (
      <OutsideYourAccess
        title="Import"
        description="Bring projects over from Dokploy."
        what="Imports"
      />
    );

  const run = await getDokployImport(id);
  if (!run) notFound();

  const when = new Date(run.startedAt).toLocaleString();
  return (
    <div className="space-y-6">
      <PageHeader
        title={run.orgName ?? run.sourceUrl}
        description={`Imported from ${run.sourceUrl} on ${when} by ${run.actor}.`}
        actions={
          <Button variant="outline" asChild>
            <Link href="/settings/import">
              <ArrowLeft className="size-4" />
              Back
            </Link>
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="secondary">{run.created} created</Badge>
        {run.skipped > 0 && <Badge variant="outline">{run.skipped} skipped</Badge>}
        {run.manual > 0 && <Badge variant="outline">{run.manual} to check</Badge>}
        {run.failed > 0 && <Badge variant="destructive">{run.failed} failed</Badge>}
        {run.status !== "done" && <Badge variant="outline">{run.status}</Badge>}
      </div>

      {run.error && (
        <p className="text-sm text-destructive">{run.error}</p>
      )}

      <ImportReport
        items={run.items}
        description="What this import did, line by line. Nothing here was deployed."
      />
    </div>
  );
}
