import { Suspense } from "react";
import { getAppBySlug } from "@/lib/data/apps/listing";
import { PendingChangesNotice } from "@/components/apps/pending-changes-notice";
import { visiblePendingChanges } from "@/lib/apps/pending-changes";

// Sync on purpose: an awaiting layout sits outside settings/loading.tsx and would block it.
export default function AppSettingsLayout(
  props: LayoutProps<"/[team]/apps/[slug]/settings">,
) {
  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <Notice params={props.params} />
      </Suspense>
      {props.children}
    </div>
  );
}

async function Notice({
  params,
}: {
  params: LayoutProps<"/[team]/apps/[slug]/settings">["params"];
}) {
  const { slug } = await params;
  const app = await getAppBySlug(slug);
  if (!app) return null;
  return (
    <PendingChangesNotice
      appId={app.id}
      slug={app.slug}
      pendingChangesAt={visiblePendingChanges(app)}
      neverDeployed={app.latestDeploymentId == null}
    />
  );
}
