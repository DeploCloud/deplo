"use client";

import { useRouter } from "next/navigation";
import { ArrowLeftRight, Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { TransferTeamDialog } from "@/components/apps/settings/transfer-team-dialog";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Danger zone: the two actions that take this app away from the team —
 * transferring it to another team the viewer belongs to, and deleting it
 * outright. Both sit in a self-describing red card at the bottom of Advanced
 * settings, each behind a typed confirmation, so neither is one stray click away
 * from Name & logo. On success the browser returns to the dashboard: in both
 * cases the app is no longer the active team's to open.
 */
export function DangerSettings({
  appId,
  name,
}: {
  appId: string;
  name: string;
}) {
  const router = useRouter();
  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base text-destructive">
          Danger Zone
          <InfoTip content="Hand this app to another team, or permanently delete it and all of its data." />
        </CardTitle>
        <CardDescription>
          These actions take the app away from this team. Each asks you to type
          the app name first.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <p className="text-sm font-medium">Transfer to another team</p>
            <p className="text-sm text-muted-foreground">
              Move this app — with its variables, domains, volumes and history —
              to another team you belong to. It keeps running throughout; this
              team loses access to it.
            </p>
          </div>
          <TransferTeamDialog
            appId={appId}
            appName={name}
            trigger={
              <Button variant="outline" size="sm">
                <ArrowLeftRight className="size-4" />
                Transfer
              </Button>
            }
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 p-4">
          <div className="min-w-56 flex-1 space-y-1">
            <p className="text-sm font-medium">Delete app</p>
            <p className="text-sm text-muted-foreground">
              Permanently remove the app, its deployments, domains and
              environment variables. This cannot be undone.
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
