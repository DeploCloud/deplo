"use client";

import { useRouter } from "@/lib/nav";
import { ArrowLeftRight, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  FeatureRow,
  RowsCard,
} from "@/components/apps/settings/settings-shared";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { TransferTeamDialog } from "@/components/apps/settings/transfer-team-dialog";
import { gqlAction } from "@/lib/graphql-client";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";

export function DangerSettings({
  appId,
  name,
}: {
  appId: string;
  name: string;
}) {
  const router = useRouter();
  const canMove = useAppCan("move_apps");
  const canDelete = useAppCan("delete_apps");
  return (
    <RowsCard
      icon={TriangleAlert}
      title="Danger zone"
      info="Hand this app to another team, or permanently delete it and all of its data. Each asks you to type the app name first."
      docs="team.overview"
      danger
    >
      <FeatureRow
        icon={ArrowLeftRight}
        title="Transfer to another team"
        description="Hand this app to another team. It keeps running; this team loses access."
        control={
          canMove ? (
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
          ) : (
            <CapabilityTip cap="move_apps">
              <Button variant="outline" size="sm" disabled>
                <ArrowLeftRight className="size-4" />
                Transfer
              </Button>
            </CapabilityTip>
          )
        }
      />
      <FeatureRow
        icon={Trash2}
        title="Delete app"
        description="Permanently remove the app, its deployments, domains and environment variables. This cannot be undone."
        control={
          canDelete ? (
            <DeleteWithArtifacts
              trigger={
                <Button variant="destructive" size="sm">
                  <Trash2 className="size-4" />
                  Delete app
                </Button>
              }
              targetName={name}
              title="Delete app?"
              description={
                <>
                  Deleting <strong>{name}</strong> removes it for good.
                </>
              }
              consequence="Its data, deployments, domains, variables and every backup it has stored go with it."
              confirmLabel="Delete app"
              successMessage="App deleted"
              deleteMutation={() =>
                gqlAction(`mutation($id: String!) { deleteApp(id: $id) }`, {
                  id: appId,
                })
              }
              onDeleted={() => router.push("/")}
            />
          ) : (
            <CapabilityTip cap="delete_apps">
              <Button variant="destructive" size="sm" disabled>
                <Trash2 className="size-4" />
                Delete app
              </Button>
            </CapabilityTip>
          )
        }
      />
    </RowsCard>
  );
}
