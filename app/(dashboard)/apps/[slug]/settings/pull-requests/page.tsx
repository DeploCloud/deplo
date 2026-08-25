import { notFound } from "next/navigation";
import Link from "next/link";
import { GitPullRequest } from "lucide-react";

import { getAppBySlug } from "@/lib/data/apps";
import { hasAppCapability } from "@/lib/data/node-access";
import { listAppPreviews } from "@/lib/data/previews";
import { listServerChoices } from "@/lib/data/servers";
import { SettingsSection } from "@/components/apps/settings/settings-shared";
import { CapabilityFieldset } from "@/components/apps/app-capabilities";
import { PreviewSettingsForm } from "@/components/apps/settings/preview-settings-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

export const metadata = { title: "Pull requests" };

/**
 * Everything that shapes a pull request preview, on a page of its own.
 */
export default async function AppPullRequestsSettingsPage(
  props: PageProps<"/apps/[slug]/settings/pull-requests">,
) {
  const { slug } = await props.params;
  const project = await getAppBySlug(slug);
  if (!project) notFound();

  const isGithubApp = project.source === "github";
  // The capability is checked BEFORE the read: `listAppPreviews` is gated and
  // throws, which would take the whole page down for someone who may still
  // configure the app perfectly well.
  const canManage = await hasAppCapability(project.id, "manage_previews");
  const [view, servers] = await Promise.all([
    isGithubApp && canManage ? listAppPreviews(project.id) : null,
    listServerChoices(),
  ]);

  return (
    <section className="space-y-4">
      <SettingsSection
        icon={GitPullRequest}
        title="Pull requests"
        info="Give every open pull request its own deploy, on its own URL, torn down when the pull request closes."
      />

      {!isGithubApp ? (
        <Card className="opacity-60">
          <CardContent className="space-y-3 pt-6">
            <p className="text-sm font-medium">
              Pull request previews need a GitHub repository
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              This app deploys from{" "}
              {project.source === "docker-image"
                ? "a container image"
                : project.source === "upload"
                  ? "an uploaded archive"
                  : project.source === "compose"
                    ? "a compose file"
                    : "a plain Git URL"}
              , so Deplo never receives its pull requests. Connect it to a
              GitHub repository and these settings turn on.
            </p>
            <div>
              <Button asChild variant="outline" size="sm">
                <Link href={`/apps/${slug}/settings/deployments`}>
                  Deploy source settings
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <CapabilityFieldset cap="manage_previews">
          {view && (
            <PreviewSettingsForm
              appId={project.id}
              branch={view.branch}
              enabled={view.enabled}
              baseDomain={view.baseDomain}
              https={view.https}
              maxActive={view.maxActive}
              ttlDays={view.ttlDays}
              forkPolicy={view.forkPolicy}
              serverId={view.serverId}
              autoDeploy={view.autoDeploy}
              port={view.port}
              buildDrafts={view.buildDrafts}
              comment={view.comment}
              requiredLabels={view.requiredLabels}
              appServerId={project.serverId}
              appPort={project.build.port}
              servers={servers}
              activeCount={
                view.previews.filter(
                  (p) =>
                    !p.closed &&
                    p.status !== "evicted" &&
                    p.status !== "blocked",
                ).length
              }
            />
          )}
        </CapabilityFieldset>
      )}
    </section>
  );
}
