import { notFound } from "next/navigation";
import { getAppBySlug } from "@/lib/data/apps";
import { PendingChangesNotice } from "@/components/apps/pending-changes-notice";

export default async function AppSettingsLayout(
  props: LayoutProps<"/[team]/apps/[slug]/settings">,
) {
  const { slug } = await props.params;
  const app = await getAppBySlug(slug);
  if (!app) notFound();

  return (
    <div className="space-y-4">
      <PendingChangesNotice
        appId={app.id}
        slug={app.slug}
        pendingChangesAt={app.pendingChangesAt ?? null}
        neverDeployed={app.latestDeploymentId == null}
      />
      {props.children}
    </div>
  );
}
