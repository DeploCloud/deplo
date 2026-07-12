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
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Settings → General danger zone. Rendered only for members who may delete the
 * team (founder / instance admin — gated server-side in the page AND re-checked
 * in the mutation). `onlyTeam` disables the action with an explanation: a user
 * must always keep at least one team.
 */
export function DeleteTeamCard({
  teamId,
  teamName,
  onlyTeam,
}: {
  teamId: string;
  teamName: string;
  onlyTeam: boolean;
}) {
  const router = useRouter();

  return (
    <Card className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base text-destructive">
          Danger zone
          <InfoTip content="Permanently delete this team, its apps, databases and members." />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {onlyTeam
            ? "You can't delete your only team — create another team first."
            : "Every app and database stack is torn down (data volumes included). This cannot be undone."}
        </p>
        <ConfirmAction
          trigger={
            <Button variant="destructive" size="sm" disabled={onlyTeam}>
              <Trash2 className="size-4" />
              Delete team
            </Button>
          }
          title={`Delete ${teamName}?`}
          description="This tears down every app and database of this team (data volumes included) and permanently removes its folders, projects, domains, environment variables, backups and members. Stack cleanup continues in the background. Backup archives already uploaded to S3 are kept. This cannot be undone."
          confirmLabel="Delete team"
          successMessage="Team deleted"
          confirmText={teamName}
          onConfirm={async () => {
            // Echo back the id the user confirmed — the server fails closed if
            // the active team changed in another tab meanwhile.
            const res = await gqlAction(
              `mutation($teamId: String!) { deleteTeam(teamId: $teamId) }`,
              { teamId },
            );
            if (res.ok) {
              // The active team is gone — land on the next team's overview.
              router.push("/");
              router.refresh();
            }
            return res;
          }}
        />
      </CardContent>
    </Card>
  );
}
