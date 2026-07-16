import { notFound } from "next/navigation";

import { PageHeader } from "@/components/shared/page-header";
import { CleanupPanel } from "@/components/settings/cleanup-panel";
import { CleanupHistory } from "@/components/settings/cleanup-history";
import { getCleanupPolicy, listCleanupRuns } from "@/lib/data/docker-cleanup";
import { listAllServers } from "@/lib/data/servers";
import { hasCapability } from "@/lib/membership";
import { serverLabel } from "@/lib/utils";

export const metadata = { title: "Settings · Docker cleanup" };

export default async function SettingsCleanupPage() {
  // Gate BEFORE the reads: getCleanupPolicy/listCleanupRuns each call
  // requireCapability("manage_infra") and throw, which would surface as a crashed
  // page rather than a missing one. The nav entry is hidden without the capability;
  // this guards the direct link, and 404s (like its sibling /settings/servers) so a
  // system page doesn't advertise its own existence to a member who can't use it.
  if (!(await hasCapability("manage_infra"))) notFound();

  const [servers, policy, runs] = await Promise.all([
    // The UNSCOPED server list on purpose: the sweep is host-coupled and the policy
    // is instance-wide, so this page must show every host — a server restricted to
    // another team still fills the same disk.
    listAllServers(),
    getCleanupPolicy(),
    // No limit: the default page IS the retention cap (3 runs × server count, ≈ three
    // days at the daily cadence) — the store keeps nothing older to show.
    listCleanupRuns(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Docker cleanup"
        description="Reclaim build cache and unused images on your servers. Stopped apps, their data volumes and their networks are never touched."
      />
      <CleanupPanel
        policy={policy}
        servers={servers.map((s) => ({ id: s.id, name: serverLabel(s) }))}
      />
      <CleanupHistory runs={runs} />
    </div>
  );
}
