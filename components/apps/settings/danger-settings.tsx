"use client";

import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { TransferAppDialog } from "@/components/apps/settings/transfer-app-dialog";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Danger zone: the two ways an app leaves this team — handed to another team,
 * or deleted outright. A self-describing red card within the Advanced settings
 * section. Both end with the app gone from here, so both sit behind their own
 * typed confirmation.
 *
 * Transfer is rendered only for a member who could actually perform it (`deploy`
 * + `manage_env`, since the app carries its secrets across the tenancy
 * boundary). The server re-checks either way — the prop only keeps a dead action
 * off the page.
 */
export function DangerSettings({
  appId,
  name,
  slug,
  canTransfer,
}: {
  appId: string;
  name: string;
  slug: string;
  canTransfer: boolean;
}) {
  const router = useRouter();
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base text-destructive">
          Danger Zone
          <InfoTip content="Hand this app to another team, or permanently delete it and all of its data." />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {canTransfer && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
            <div className="min-w-56 flex-1 space-y-1">
              <p className="text-sm font-medium">Transfer to another team</p>
              <p className="text-sm text-muted-foreground">
                Move this app to a team you belong to and can deploy in. It takes
                its variables, domains, deployments and volumes along and keeps
                running on the same URLs, but it leaves this team for good — only
                the new team can move it back.
              </p>
            </div>
            <TransferAppDialog appId={appId} appName={name} appSlug={slug} />
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <p className="text-sm font-medium">Delete app</p>
            <p className="text-sm text-muted-foreground">
              Permanently remove this app, its container and everything it owns —
              deployments, domains and environment variables.
            </p>
          </div>
          <DeleteWithArtifacts
            trigger={
              <Button variant="destructive" size="sm">
                <Trash2 className="size-4" />
                Delete App
              </Button>
            }
            targetKind="app"
            targetId={appId}
            targetName={name}
            title={`Delete ${name}?`}
            description="This permanently removes the app, deployments, domains and environment variables. This cannot be undone."
            confirmLabel="Delete app"
            successMessage="App deleted"
            deleteMutation={() =>
              gqlAction(`mutation($id: String!) { deleteApp(id: $id) }`, {
                id: appId,
              })
            }
            onDeleted={() => router.push("/")}
          />
        </div>
      </CardContent>
    </Card>
  );
}
